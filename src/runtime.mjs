import { assertProtocol, protocolProfiles } from "house-protocols";
import { ExecutionCancelledError, ExecutionTimeoutError, runWithControls } from "./execution-control.mjs";
import { createId, isoTime, runScopedId, sha256 } from "./ids.mjs";
import { LifeClock } from "./life-clock.mjs";
import { assertMemoryPort, SQLiteMemoryPort } from "./memory-port.mjs";
import { assertMemoryPortCandidate } from "./memory-port-candidate.mjs";
import { RoomQueue } from "./room-queue.mjs";
import { RuntimeStore } from "./store.mjs";
import { Workspace } from "./workspace.mjs";

function assertString(value, name, maximum = 2000) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`${name} must be a non-empty string no longer than ${maximum} characters`);
}

function normalizeReference(reference) {
  if (!reference || typeof reference !== "object") throw new Error("context reference must be an object");
  assertString(reference.ref_id, "context reference ref_id", 160);
  assertString(reference.kind, "context reference kind", 40);
  assertString(reference.locator, "context reference locator", 1024);
  const allowedKinds = new Set(["event", "message", "memory", "artifact", "source", "claim", "evidence", "lifecycle", "scheduler_lease", "capability_grant", "life_state", "opportunity", "journal", "dream", "handoff", "other"]);
  if (!allowedKinds.has(reference.kind)) throw new Error(`unsupported context reference kind: ${reference.kind}`);
  return {
    ref_id: reference.ref_id,
    kind: reference.kind,
    locator: reference.locator,
    ...(reference.digest ? { digest: reference.digest } : {}),
    ...(reference.observed_at ? { observed_at: reference.observed_at } : {}),
  };
}

function validateProposal(proposal) {
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) throw new Error("adapter proposal must be an object");
  assertExactKeys(proposal, new Set(["response_text", "work"]), "adapter proposal");
  assertString(proposal.response_text, "proposal response_text", 16000);
  if (!proposal.work) return proposal;
  if (typeof proposal.work !== "object" || Array.isArray(proposal.work)) throw new Error("proposal work must be an object");
  assertExactKeys(proposal.work, new Set(["goal", "artifacts", "reflection"]), "proposal work");
  assertString(proposal.work.goal, "proposal work goal", 2000);
  if (!Array.isArray(proposal.work.artifacts) || proposal.work.artifacts.length < 1 || proposal.work.artifacts.length > 10) {
    throw new Error("proposal work must contain between one and ten artifacts");
  }
  for (const artifact of proposal.work.artifacts) {
    if (!artifact || typeof artifact !== "object") throw new Error("artifact proposal must be an object");
    assertExactKeys(artifact, new Set(["path", "content"]), "artifact proposal");
    assertString(artifact.path, "artifact path", 512);
    if (typeof artifact.content !== "string") throw new Error("artifact content must be a string");
  }
  if (proposal.work.reflection != null) assertString(proposal.work.reflection, "proposal reflection", 16000);
  return proposal;
}

function validateLifecycleDecision(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("lifecycle decision must be an object");
  assertExactKeys(value, new Set(["decision", "reason_codes", "outcome"]), "lifecycle decision");
  if (!new Set(["accept", "decline"]).has(value.decision)) throw new Error("lifecycle decision must be accept or decline");
  if (!Array.isArray(value.reason_codes) || !value.reason_codes.length || new Set(value.reason_codes).size !== value.reason_codes.length || value.reason_codes.some((item) => typeof item !== "string" || !/^[a-z][a-z0-9_.-]{1,119}$/.test(item))) {
    throw new Error("lifecycle decision requires reason_codes");
  }
  if (value.decision === "decline") {
    if (value.outcome != null) throw new Error("declined lifecycle decisions cannot contain an outcome");
    return value;
  }
  if (!value.outcome || typeof value.outcome !== "object" || Array.isArray(value.outcome)) throw new Error("accepted lifecycle decisions require an outcome");
  assertExactKeys(value.outcome, new Set(["type", "content"]), "lifecycle outcome");
  if (!new Set(["journal", "dream", "handoff", "initiative"]).has(value.outcome.type)) throw new Error("unsupported lifecycle outcome type");
  if (!value.outcome.content || typeof value.outcome.content !== "object" || Array.isArray(value.outcome.content)) throw new Error("lifecycle outcome content must be an object");
  return value;
}

function assertExactKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${name} contains unsupported field: ${key}`);
  }
}

function publicRun(run) {
  if (!run) return null;
  const { result_json, error_json, ...rest } = run;
  return rest;
}

export class HouseRuntime {
  #agents = new Map();
  #scheduled = new Map();
  #controllers = new Map();
  #leases = new Map();
  #lifecycles = new Map();

  constructor({ dbPath, workspaceDir, instanceId = "instance:fictional-demo", userId = "user:avery", runtimeId = createId("runtime"), protocolVersion = "0.2", clock = () => new Date(), timer, leaseMs = 30000, defaultTimeoutMs = 120000, defaultMaxAttempts = 3, confirmationVerifier = null, memoryPolicy = null, memoryPort = null, memoryAdapter = null, memoryOperationMaxAttempts = 5 }) {
    assertString(instanceId, "instanceId", 160);
    assertString(userId, "userId", 160);
    assertString(runtimeId, "runtimeId", 160);
    if (!protocolProfiles().includes(protocolVersion)) throw new Error(`unsupported protocolVersion: ${protocolVersion}`);
    if (!Number.isInteger(leaseMs) || leaseMs < 1000) throw new Error("leaseMs must be an integer of at least 1000");
    if (!Number.isInteger(defaultTimeoutMs) || defaultTimeoutMs < 1) throw new Error("defaultTimeoutMs must be a positive integer");
    if (!Number.isInteger(defaultMaxAttempts) || defaultMaxAttempts < 1 || defaultMaxAttempts > 20) throw new Error("defaultMaxAttempts must be between 1 and 20");
    if (!Number.isInteger(memoryOperationMaxAttempts) || memoryOperationMaxAttempts < 1 || memoryOperationMaxAttempts > 20) throw new Error("memoryOperationMaxAttempts must be between 1 and 20");
    if (memoryPort && memoryAdapter) throw new Error("memoryPort and memoryAdapter cannot both be configured");
    this.instanceId = instanceId;
    this.userId = userId;
    this.runtimeId = runtimeId;
    this.protocolVersion = protocolVersion;
    this.clock = clock;
    this.timer = timer;
    this.leaseMs = leaseMs;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.defaultMaxAttempts = defaultMaxAttempts;
    this.confirmationVerifier = confirmationVerifier;
    this.memoryPolicy = memoryPolicy;
    this.memoryOperationMaxAttempts = memoryOperationMaxAttempts;
    this.store = new RuntimeStore(dbPath);
    this.memoryPort = assertMemoryPort(memoryPort || new SQLiteMemoryPort(this.store));
    this.memoryAdapter = memoryAdapter ? assertMemoryPortCandidate(memoryAdapter) : null;
    this.workspace = new Workspace(workspaceDir);
    this.roomQueue = new RoomQueue();
  }

  registerAgent(agentId, adapter) {
    assertString(agentId, "agentId", 160);
    if (!adapter || typeof adapter.generate !== "function") throw new Error("agent adapter must implement generate(input)");
    this.#agents.set(agentId, adapter);
    return this;
  }

  registerLifecycle(subjectId, { schedule, adapter }) {
    assertString(subjectId, "lifecycle subjectId", 160);
    if (!adapter || typeof adapter.consider !== "function") throw new Error("lifecycle adapter must implement consider(input)");
    this.#lifecycles.set(subjectId, { clock: new LifeClock(schedule), adapter });
    return this;
  }

  async pollLifecycle(subjectId = null) {
    const registrations = subjectId
      ? [[subjectId, this.#lifecycles.get(subjectId)]]
      : [...this.#lifecycles.entries()];
    if (subjectId && !registrations[0][1]) throw new Error(`no lifecycle registered for ${subjectId}`);
    const results = [];
    for (const [currentSubject, registration] of registrations) {
      const at = isoTime(this.clock);
      const now = new Date(at);
      this.store.expireOpportunities(currentSubject, at);
      const state = registration.clock.stateAt(now);
      let lifeState = this.store.getLatestLifeState(currentSubject);
      if (!lifeState || lifeState.state !== state || lifeState.schedule_id !== registration.clock.scheduleId) {
        lifeState = {
          protocol_version: "0.2",
          state_id: createId("life-state"),
          subject_id: currentSubject,
          state,
          effective_at: at,
          schedule_id: registration.clock.scheduleId,
          ...(lifeState ? { previous_state_id: lifeState.state_id } : {}),
        };
        assertProtocol("life_state", lifeState, { profile: "0.2" });
        this.store.saveLifeState(lifeState);
      }

      for (const window of registration.clock.dueWindows(now)) {
        const opportunityId = `opportunity:${sha256(`${currentSubject}|${window.rule.rule_id}|${window.start.toISOString()}`).slice("sha256:".length)}`;
        const opportunity = {
          protocol_version: "0.2",
          opportunity_id: opportunityId,
          subject_id: currentSubject,
          opportunity_type: window.rule.opportunity_type,
          status: "offered",
          window_start: window.start.toISOString(),
          window_end: window.end.toISOString(),
          created_at: at,
          reason_codes: [window.catchUp ? "catch_up_after_downtime" : "configured_window"],
          source_refs: [{ ref_id: lifeState.state_id, kind: "life_state", locator: `life-states/${lifeState.state_id}`, observed_at: lifeState.effective_at }],
        };
        assertProtocol("lifecycle_opportunity", opportunity, { profile: "0.2" });
        const saved = this.store.saveOpportunity(window.rule.rule_id, opportunity, { maxAttempts: window.rule.max_attempts, retryDelayMinutes: window.rule.retry_delay_minutes });
        if (!window.rule.allowed_states.includes(state) && saved.status === "offered") {
          const declined = { ...saved, status: "declined", reason_codes: [...new Set([...saved.reason_codes, "state_not_allowed"])] };
          assertProtocol("lifecycle_opportunity", declined, { profile: "0.2" });
          this.store.resolveOpportunity(saved.opportunity_id, declined);
        }
      }

      const open = this.store.listOpenOpportunities(currentSubject, at);
      for (const opportunity of open) {
        const controller = new AbortController();
        let decision;
        try {
          const memories = await this.#queryMemories(currentSubject, 20);
          decision = validateLifecycleDecision(await runWithControls(() => registration.adapter.consider({
            opportunity: structuredClone(opportunity),
            life_state: structuredClone(lifeState),
            context: {
              memories: structuredClone(memories),
              journals: structuredClone(this.store.listLifecycleRecords(currentSubject, "journal", 5)),
              dreams: structuredClone(this.store.listLifecycleRecords(currentSubject, "dream", 5)),
              handoffs: structuredClone(this.store.listLifecycleRecords(currentSubject, "handoff", 5)),
            },
            signal: controller.signal,
          }), { signal: controller.signal, timeoutMs: this.defaultTimeoutMs, timer: this.timer }));
        } catch (error) {
          this.#audit(null, "lifecycle_consider_failed", { opportunity_id: opportunity.opportunity_id, subject_id: currentSubject, error_name: error.name }, at);
          const failed = this.store.recordOpportunityFailure(opportunity.opportunity_id, at);
          results.push({ opportunity_id: opportunity.opportunity_id, status: failed?.status || "offered", error: error.name });
          continue;
        }

        if (decision.decision === "decline") {
          const declined = { ...opportunity, status: "declined", reason_codes: [...new Set([...opportunity.reason_codes, ...decision.reason_codes])] };
          assertProtocol("lifecycle_opportunity", declined, { profile: "0.2" });
          this.store.resolveOpportunity(opportunity.opportunity_id, declined);
          results.push({ opportunity_id: opportunity.opportunity_id, status: "declined" });
          continue;
        }

        let materialized;
        try {
          materialized = await this.#materializeLifecycle(opportunity, decision.outcome, at);
        } catch (error) {
          this.#audit(null, "lifecycle_materialize_failed", { opportunity_id: opportunity.opportunity_id, subject_id: currentSubject, error_name: error.name }, at);
          const failed = this.store.recordOpportunityFailure(opportunity.opportunity_id, at);
          results.push({ opportunity_id: opportunity.opportunity_id, status: failed?.status || "offered", error: error.name });
          continue;
        }
        const accepted = {
          ...opportunity,
          status: "accepted",
          reason_codes: [...new Set([...opportunity.reason_codes, ...decision.reason_codes])],
          response_ref: materialized.reference,
        };
        assertProtocol("lifecycle_opportunity", accepted, { profile: "0.2" });
        this.store.transaction(() => {
          if (materialized.record) this.store.saveLifecycleRecord(materialized.kind, opportunity.opportunity_id, materialized.record);
          this.store.resolveOpportunity(opportunity.opportunity_id, accepted, materialized.kind, materialized.id);
        });
        results.push({ opportunity_id: opportunity.opportunity_id, status: "accepted", response_kind: materialized.kind, response_id: materialized.id });
      }
    }
    return results;
  }

  putKeel(keel) {
    assertProtocol("keel", keel);
    this.store.insertKeel(keel);
    return keel;
  }

  getCurrentKeel(subjectId) {
    return this.store.getCurrentKeel(subjectId);
  }

  queueRequest({ roomId, agentId, message, idempotencyKey, contextRefs = [], timeoutMs = this.defaultTimeoutMs, maxAttempts = this.defaultMaxAttempts, capabilityGrant = null }) {
    assertString(roomId, "roomId", 160);
    assertString(agentId, "agentId", 160);
    assertString(message, "message", 32000);
    assertString(idempotencyKey, "idempotencyKey", 200);
    if (idempotencyKey.length < 8) throw new Error("idempotencyKey must be at least 8 characters");
    if (!Array.isArray(contextRefs) || contextRefs.length > 32) throw new Error("contextRefs must contain at most 32 references");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("timeoutMs must be a positive integer");
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new Error("maxAttempts must be between 1 and 20");

    const existingEvent = this.store.findEventByIdempotency(idempotencyKey);
    if (existingEvent) return publicRun(this.store.getRunByRequestEvent(existingEvent.event_id));

    const at = isoTime(this.clock);
    if (capabilityGrant) {
      assertProtocol("capability_grant", capabilityGrant, { profile: "0.2" });
      if (capabilityGrant.grantee_id !== agentId) throw new Error("capability grant grantee does not match the requested agent");
      if (capabilityGrant.revoked_at) throw new Error("capability grant is revoked");
      if (capabilityGrant.not_before && Date.parse(at) < Date.parse(capabilityGrant.not_before)) throw new Error("capability grant is not active yet");
      if (capabilityGrant.expires_at && Date.parse(at) >= Date.parse(capabilityGrant.expires_at)) throw new Error("capability grant is expired");
    }
    const event = {
      protocol_version: this.protocolVersion,
      event_id: createId("event"),
      event_type: "user:message",
      source: this.userId,
      target: agentId,
      occurred_at: at,
      idempotency_key: idempotencyKey,
      payload: {
        room_id: roomId,
        message,
        context_refs: contextRefs.map(normalizeReference),
      },
    };
    assertProtocol("event", event);
    const run = {
      run_id: createId("run"),
      room_id: roomId,
      agent_id: agentId,
      request_event_id: event.event_id,
      status: "queued",
      timeout_ms: timeoutMs,
      max_attempts: maxAttempts,
      created_at: at,
      updated_at: at,
    };
    const needsConfirmation = capabilityGrant?.confirmation_mode === "each_use";
    const confirmation = needsConfirmation
      ? {
          confirmation_id: runScopedId("confirmation", run.run_id),
          action_digest: sha256(JSON.stringify({ event_id: event.event_id, grant_id: capabilityGrant.grant_id, capability: capabilityGrant.capability, scope: capabilityGrant.scope })),
        }
      : null;
    this.store.transaction(() => {
      this.store.insertEvent(event, roomId);
      this.store.createRun(run);
      if (confirmation) this.store.createConfirmation(run.run_id, confirmation, capabilityGrant, at);
      this.#audit(run.run_id, confirmation ? "confirmation_requested" : "run_queued", { confirmation_id: confirmation?.confirmation_id || null }, at);
    });
    return publicRun(this.store.getRun(run.run_id));
  }

  async submit(request) {
    if (!this.#agents.has(request.agentId)) throw new Error(`no adapter registered for ${request.agentId}`);
    const run = this.queueRequest(request);
    if (run.status === "waiting_confirmation") return run;
    return this.executeRun(run.run_id);
  }

  retryRun(runId) {
    const run = this.store.getRun(runId);
    if (!run) return Promise.reject(new Error(`unknown run: ${runId}`));
    if (run.status === "completed") return Promise.resolve(publicRun(run));
    if (run.status === "cancelled") return Promise.reject(new Error(`cancelled run requires a new request: ${runId}`));
    const at = isoTime(this.clock);
    if (["failed", "timed_out"].includes(run.status) && !this.store.requeueRun(runId, at)) {
      return Promise.reject(new Error(`failed to requeue run: ${runId}`));
    }
    this.#audit(runId, "run_retried", { next_attempt: run.attempts + 1, max_attempts: run.max_attempts }, at);
    return this.executeRun(runId);
  }

  async resolveConfirmation({ confirmationId, decision, authentication }) {
    assertString(confirmationId, "confirmationId", 160);
    if (!new Set(["approve", "deny"]).has(decision)) throw new Error("decision must be approve or deny");
    if (typeof this.confirmationVerifier !== "function") throw new Error("confirmationVerifier is required to resolve confirmation challenges");
    const pending = this.store.getConfirmation(confirmationId);
    if (!pending || pending.status !== "pending") throw new Error(`unknown or resolved confirmation: ${confirmationId}`);
    const verified = await this.confirmationVerifier({ authentication, confirmation: structuredClone(pending), decision });
    assertString(verified?.subject_id, "verified subject_id", 160);
    const at = isoTime(this.clock);
    const resolved = this.store.resolveConfirmation(confirmationId, decision === "approve" ? "approved" : "denied", verified.subject_id, at);
    if (!resolved) throw new Error(`unknown or resolved confirmation: ${confirmationId}`);
    this.#audit(resolved.run_id, "confirmation_resolved", { confirmation_id: confirmationId, decision, authenticated_by: verified.subject_id }, at);
    if (decision === "deny") return publicRun(this.store.getRun(resolved.run_id));
    return this.executeRun(resolved.run_id);
  }

  cancelRun(runId, { authenticatedBy = this.userId, reason = "cancelled_by_user" } = {}) {
    assertString(authenticatedBy, "authenticatedBy", 160);
    assertString(reason, "reason", 240);
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    if (["completed", "cancelled", "timed_out"].includes(run.status)) return publicRun(run);
    const at = isoTime(this.clock);
    this.store.setTerminalStatus(runId, "cancelled", { name: "ExecutionCancelledError", message: reason }, at);
    this.#controllers.get(runId)?.abort();
    const lease = this.#leases.get(runId);
    if (lease) this.store.releaseLease(lease.lease_id, at);
    this.#audit(runId, "run_cancelled", { authenticated_by: authenticatedBy, reason }, at);
    return publicRun(this.store.getRun(runId));
  }

  executeRun(runId) {
    const existing = this.#scheduled.get(runId);
    if (existing) return existing;
    const run = this.store.getRun(runId);
    if (!run) return Promise.reject(new Error(`unknown run: ${runId}`));
    if (["completed", "failed", "cancelled", "timed_out", "waiting_confirmation"].includes(run.status)) return Promise.resolve(publicRun(run));
    const scheduled = this.roomQueue.run(run.room_id, () => this.#executeNow(runId)).finally(() => this.#scheduled.delete(runId));
    this.#scheduled.set(runId, scheduled);
    return scheduled;
  }

  async resumePending() {
    if (this.memoryAdapter) await this.drainMemoryOperations();
    return Promise.all(this.store.listPendingRuns().map((run) => this.executeRun(run.run_id)));
  }

  async #materializeLifecycle(opportunity, outcome, at) {
    const allowed = {
      tick: new Set(["journal", "initiative"]),
      journal: new Set(["journal"]),
      dream: new Set(["dream"]),
      handoff: new Set(["handoff"]),
      feedback: new Set(["journal"]),
    };
    if (!allowed[opportunity.opportunity_type]?.has(outcome.type)) {
      throw new Error(`${opportunity.opportunity_type} opportunities cannot produce ${outcome.type}`);
    }
    const content = outcome.content;
    const suffix = opportunity.opportunity_id.slice("opportunity:".length);

    if (outcome.type === "initiative") {
      assertExactKeys(content, new Set(["room_id", "message"]), "lifecycle initiative content");
      assertString(content.room_id, "lifecycle initiative room_id", 160);
      assertString(content.message, "lifecycle initiative message", 32000);
      if (!this.#agents.has(opportunity.subject_id)) throw new Error(`no adapter registered for ${opportunity.subject_id}`);
      const run = await this.submit({
        roomId: content.room_id,
        agentId: opportunity.subject_id,
        message: content.message,
        idempotencyKey: `lifecycle:${suffix}`,
      });
      return {
        kind: "initiative",
        id: run.run_id,
        reference: { ref_id: run.run_id, kind: "other", locator: `runs/${run.run_id}`, observed_at: run.created_at },
      };
    }

    if (outcome.type === "journal") {
      assertExactKeys(content, new Set(["events", "reflections", "intentions"]), "lifecycle journal content");
      if (!Array.isArray(content.events) || !Array.isArray(content.reflections) || !Array.isArray(content.intentions)) throw new Error("journal content requires event, reflection, and intention arrays");
      const document = {
        protocol_version: "0.2",
        journal_id: `journal:${suffix}`,
        subject_id: opportunity.subject_id,
        period_start: opportunity.window_start,
        period_end: at,
        events: content.events.map((item, index) => {
          assertExactKeys(item, new Set(["statement", "epistemic_status", "source_refs", "evidence_refs"]), "journal event");
          return { ...structuredClone(item), entry_id: `journal-event:${suffix}:${index + 1}` };
        }),
        reflections: content.reflections.map((item, index) => {
          assertExactKeys(item, new Set(["body", "source_refs"]), "journal reflection");
          return { ...structuredClone(item), reflection_id: `journal-reflection:${suffix}:${index + 1}` };
        }),
        intentions: content.intentions.map((item, index) => {
          assertExactKeys(item, new Set(["body", "status"]), "journal intention");
          return { ...structuredClone(item), intention_id: `intention:${suffix}:${index + 1}` };
        }),
        created_at: at,
      };
      assertProtocol("journal_entry", document, { profile: "0.2" });
      return {
        kind: "journal",
        id: document.journal_id,
        record: document,
        reference: { ref_id: document.journal_id, kind: "journal", locator: `lifecycle/journals/${document.journal_id}`, observed_at: at },
      };
    }

    if (outcome.type === "dream") {
      assertExactKeys(content, new Set(["body", "fragment_refs", "affect_words"]), "lifecycle dream content");
      const document = {
        protocol_version: "0.2",
        dream_id: `dream:${suffix}`,
        subject_id: opportunity.subject_id,
        period_start: opportunity.window_start,
        period_end: at,
        factuality: "non_factual",
        body: content.body,
        fragment_refs: structuredClone(content.fragment_refs || []),
        ...(content.affect_words ? { affect_words: structuredClone(content.affect_words) } : {}),
        created_at: at,
      };
      assertProtocol("dream_record", document, { profile: "0.2" });
      return {
        kind: "dream",
        id: document.dream_id,
        record: document,
        reference: { ref_id: document.dream_id, kind: "dream", locator: `lifecycle/dreams/${document.dream_id}`, observed_at: at },
      };
    }

    assertExactKeys(content, new Set(["open_initiative_refs", "completed_initiative_refs", "unresolved_questions", "source_refs"]), "lifecycle handoff content");
    const document = {
      protocol_version: "0.2",
      handoff_id: `handoff:${suffix}`,
      subject_id: opportunity.subject_id,
      period_start: opportunity.window_start,
      period_end: at,
      open_initiative_refs: structuredClone(content.open_initiative_refs || []),
      completed_initiative_refs: structuredClone(content.completed_initiative_refs || []),
      unresolved_questions: structuredClone(content.unresolved_questions || []),
      source_refs: structuredClone(content.source_refs || []),
      created_at: at,
    };
    assertProtocol("handoff_record", document, { profile: "0.2" });
    return {
      kind: "handoff",
      id: document.handoff_id,
      record: document,
      reference: { ref_id: document.handoff_id, kind: "handoff", locator: `lifecycle/handoffs/${document.handoff_id}`, observed_at: at },
    };
  }

  async #executeNow(runId) {
    let run = this.store.getRun(runId);
    if (["completed", "failed", "cancelled", "timed_out", "waiting_confirmation"].includes(run.status)) return publicRun(run);
    const adapter = this.#agents.get(run.agent_id);
    if (!adapter) throw new Error(`no adapter registered for ${run.agent_id}`);
    const startedAt = isoTime(this.clock);
    const leaseDuration = Math.max(this.leaseMs, run.timeout_ms + 1000);
    const lease = this.store.acquireLease({
      protocol_version: "0.2",
      lease_id: runScopedId("lease", run.run_id, createId("attempt").slice("attempt:".length)),
      run_id: run.run_id,
      work_ref: { ref_id: run.run_id, kind: "other", locator: `runs/${run.run_id}` },
      holder_id: this.runtimeId,
      status: "active",
      acquired_at: startedAt,
      expires_at: new Date(Date.parse(startedAt) + leaseDuration).toISOString(),
    });
    if (!lease) {
      this.#audit(runId, "lease_conflict", {}, startedAt);
      return publicRun(this.store.getRun(runId));
    }
    assertProtocol("scheduler_lease", lease, { profile: "0.2" });
    this.#leases.set(runId, lease);
    this.#audit(runId, "lease_acquired", { lease_id: lease.lease_id, fencing_token: lease.fencing_token }, startedAt);
    if (!this.store.markRunRunning(runId, startedAt)) {
      this.store.releaseLease(lease.lease_id, startedAt);
      this.#leases.delete(runId);
      this.store.failRun(runId, { name: "RetryBudgetExceeded", message: "Run has no remaining attempts." }, startedAt);
      this.#audit(runId, "retry_budget_exhausted", { max_attempts: run.max_attempts }, startedAt);
      return publicRun(this.store.getRun(runId));
    }
    const controller = new AbortController();
    this.#controllers.set(runId, controller);

    try {
      const event = this.store.getEvent(run.request_event_id);
      const context = await this.#buildContext(run, event, startedAt);
      let proposal = this.store.getProposal(runId);
      if (!proposal) {
        proposal = validateProposal(await runWithControls(() => adapter.generate({
          run: publicRun(this.store.getRun(runId)),
          event: structuredClone(event),
          context: structuredClone(context.adapterContext),
          signal: controller.signal,
        }), { signal: controller.signal, timeoutMs: run.timeout_ms, timer: this.timer }));
        this.store.saveProposal(runId, proposal, isoTime(this.clock));
      } else {
        validateProposal(proposal);
      }
      if (controller.signal.aborted) throw new ExecutionCancelledError();

      const result = await this.#materialize(run, event, proposal);
      run = this.store.getRun(runId);
      return publicRun(run || { ...run, result });
    } catch (error) {
      const at = isoTime(this.clock);
      const sanitized = { name: error.name, message: this.#sanitizeErrorMessage(error.message) };
      if (error instanceof ExecutionCancelledError) {
        if (this.store.getRun(runId).status !== "cancelled") {
          this.store.setTerminalStatus(runId, "cancelled", sanitized, at);
          this.#audit(runId, "run_cancelled", {}, at);
        }
      } else if (error instanceof ExecutionTimeoutError) {
        this.store.setTerminalStatus(runId, "timed_out", sanitized, at);
        this.#audit(runId, "run_timed_out", { timeout_ms: run.timeout_ms }, at);
      } else {
        this.store.failRun(runId, sanitized, at);
        this.#audit(runId, "run_failed", { error_name: error.name }, at);
      }
      return publicRun(this.store.getRun(runId));
    } finally {
      this.#controllers.delete(runId);
      const released = this.store.releaseLease(lease.lease_id, isoTime(this.clock));
      if (released) {
        assertProtocol("scheduler_lease", released, { profile: "0.2" });
        this.#audit(runId, "lease_released", { lease_id: lease.lease_id, fencing_token: lease.fencing_token }, released.released_at);
      }
      this.#leases.delete(runId);
    }
  }

  #sanitizeErrorMessage(message) {
    return String(message)
      .replaceAll(this.workspace.root, "<workspace>")
      .replaceAll(this.store.path, "<database>");
  }

  #audit(runId, eventType, detail = {}, at = isoTime(this.clock)) {
    this.store.saveAudit({
      audit_id: createId("audit"),
      run_id: runId,
      event_type: eventType,
      actor_id: this.runtimeId,
      detail,
      occurred_at: at,
    });
  }

  #offerFeedback(runId, deliveredEvent, at) {
    const run = this.store.getRun(runId);
    if (!run || !this.#lifecycles.has(run.agent_id)) return null;
    const opportunity = {
      protocol_version: "0.2",
      opportunity_id: `opportunity:${sha256(`feedback|${runId}`).slice("sha256:".length)}`,
      subject_id: run.agent_id,
      opportunity_type: "feedback",
      status: "offered",
      window_start: at,
      window_end: new Date(Date.parse(at) + 86400000).toISOString(),
      created_at: at,
      reason_codes: ["delivery_confirmed"],
      source_refs: [
        { ref_id: deliveredEvent.event_id, kind: "event", locator: `events/${deliveredEvent.event_id}`, observed_at: deliveredEvent.occurred_at },
        ...(run.result?.initiative_id ? [{ ref_id: run.result.initiative_id, kind: "other", locator: `initiatives/${run.result.initiative_id}` }] : []),
        ...(run.result?.evidence_bundle_id ? [{ ref_id: run.result.evidence_bundle_id, kind: "evidence", locator: `evidence/${run.result.evidence_bundle_id}` }] : []),
      ],
    };
    assertProtocol("lifecycle_opportunity", opportunity, { profile: "0.2" });
    return this.store.saveOpportunity(`feedback:${runId}`, opportunity, { maxAttempts: 1, retryDelayMinutes: 15 });
  }

  async #buildContext(run, event, at) {
    const keel = this.store.getCurrentKeel(run.agent_id);
    const memories = await this.#queryMemories(run.agent_id, 20);
    const requestedRefs = (event.payload.context_refs || []).map(normalizeReference);
    const entries = [
      {
        ref_id: event.event_id,
        kind: "event",
        locator: `events/${event.event_id}`,
        observed_at: event.occurred_at,
        purpose: "current user request",
      },
      ...requestedRefs.map((reference) => ({ ...reference, purpose: "caller-requested context" })),
      ...memories.map((memory) => ({
        ref_id: memory.memory_id,
        kind: "memory",
        locator: `memories/${memory.memory_id}`,
        observed_at: memory.created_at,
        purpose: "recent active memory",
      })),
    ];
    if (keel) {
      entries.push({
        ref_id: keel.keel_id,
        kind: "source",
        locator: `keels/${keel.keel_id}/revisions/${keel.revision}`,
        observed_at: keel.created_at,
        purpose: "current Keel revision",
      });
    }
    const manifest = {
      protocol_version: this.protocolVersion,
      manifest_id: runScopedId("manifest", run.run_id),
      run_id: run.run_id,
      subject_id: run.agent_id,
      created_at: at,
      entries,
      budget: { item_count: entries.length },
    };
    assertProtocol("context_manifest", manifest);
    this.store.saveManifest(run.run_id, manifest);

    const attachments = requestedRefs
      .filter((reference) => reference.kind === "artifact")
      .map((reference) => {
        const artifact = this.store.getArtifact(reference.ref_id);
        if (!artifact || artifact.locator !== reference.locator) throw new Error(`unknown artifact reference: ${reference.ref_id}`);
        return { reference, content: this.workspace.readArtifact(artifact.locator) };
      });
    return {
      manifest,
      adapterContext: {
        keel,
        memories: memories.map(({ memory_id, kind, body, source_refs, evidence_refs, created_at }) => ({ memory_id, kind, body, source_refs, evidence_refs, created_at })),
        attachments,
      },
    };
  }

  async #materialize(run, requestEvent, proposal) {
    const now = isoTime(this.clock);
    const initiativeId = runScopedId("initiative", run.run_id);
    const evidenceId = runScopedId("evidence", run.run_id);
    let initiative = null;
    let evidence = null;
    let artifacts = [];
    let memory = null;
    let memoryDecision = null;
    let resignature = null;
    let expectedPreviousResignatureId = null;

    if (proposal.work) {
      const active = {
        protocol_version: this.protocolVersion,
        initiative_id: initiativeId,
        owner_id: run.agent_id,
        goal: proposal.work.goal,
        status: "active",
        created_at: run.created_at,
        updated_at: now,
        actual_actions: [],
        outputs: [],
        evidence_refs: [],
      };
      assertProtocol("initiative", active);
      this.store.saveInitiative(run.run_id, active);

      artifacts = proposal.work.artifacts.map((specification, index) => {
        const artifactId = runScopedId("artifact", run.run_id, String(index + 1));
        return this.workspace.writeArtifact(run.run_id, artifactId, specification);
      });
      const finishedAt = isoTime(this.clock);
      evidence = {
        protocol_version: this.protocolVersion,
        bundle_id: evidenceId,
        created_at: finishedAt,
        claims: artifacts.map((artifact, index) => ({
          claim_id: runScopedId("claim", run.run_id, String(index + 1)),
          claim_type: "action_result",
          statement: `The runtime wrote artifact ${artifact.artifact_id}.`,
          truth_confidence: 1,
          status: "supported",
        })),
        evidence: artifacts.map((artifact, index) => ({
          evidence_id: runScopedId("evidence-item", run.run_id, String(index + 1)),
          supports_claim_ids: [runScopedId("claim", run.run_id, String(index + 1))],
          evidence_type: "artifact",
          source_ref: {
            ref_id: artifact.artifact_id,
            kind: "artifact",
            locator: artifact.locator,
            digest: artifact.digest,
            observed_at: finishedAt,
          },
          observed_at: finishedAt,
          retrieval_confidence: 1,
          excerpt_digest: artifact.digest,
        })),
      };
      assertProtocol("evidence", evidence);
      initiative = {
        ...active,
        status: "completed",
        updated_at: finishedAt,
        actual_actions: artifacts.map((artifact, index) => ({
          action_id: runScopedId("action", run.run_id, String(index + 1)),
          action_type: "write_artifact",
          started_at: now,
          finished_at: finishedAt,
          status: "succeeded",
          result_summary: `Wrote ${artifact.size_bytes} bytes and verified ${artifact.digest}.`,
        })),
        outputs: artifacts.map((artifact) => ({
          output_id: artifact.artifact_id,
          output_type: "artifact",
          locator: artifact.locator,
          digest: artifact.digest,
        })),
        evidence_refs: [evidence.bundle_id],
      };
      assertProtocol("initiative", initiative);

      if (proposal.work.reflection && this.memoryPolicy?.decide) {
        memory = {
          memory_id: runScopedId("memory", run.run_id, "reflection"),
          subject_id: run.agent_id,
          kind: "reflection",
          body: proposal.work.reflection,
          source_refs: [
            { ref_id: requestEvent.event_id, kind: "event", locator: `events/${requestEvent.event_id}` },
            { ref_id: evidence.bundle_id, kind: "evidence", locator: `evidence/${evidence.bundle_id}` },
          ],
          evidence_refs: [evidence.bundle_id],
          status: "active",
          created_at: finishedAt,
        };
        memoryDecision = await this.memoryPolicy.decide({ operation: "write", candidate: structuredClone(memory), run: publicRun(run) });
        assertProtocol("memory_policy_decision", memoryDecision);
        if (memoryDecision.operation !== "write" || memoryDecision.subject_id !== memory.subject_id || memoryDecision.resource_ref.ref_id !== memory.memory_id) {
          throw new Error("memory policy decision does not match the candidate");
        }
        if (memoryDecision.decision === "quarantine") memory.status = "quarantined";
        else if (memoryDecision.decision !== "allow") memory = null;
        if (memory?.status === "active" && this.protocolVersion === "0.2") {
          const previous = await this.#latestResignature(run.agent_id);
          expectedPreviousResignatureId = previous?.resignature_id || null;
          resignature = {
            protocol_version: "0.2",
            resignature_id: runScopedId("resignature", run.run_id, "reflection"),
            subject_id: run.agent_id,
            source_ref: { ref_id: requestEvent.event_id, kind: "event", locator: `events/${requestEvent.event_id}`, observed_at: requestEvent.occurred_at },
            ...(previous ? { previous_resignature_id: previous.resignature_id } : {}),
            layer: (previous?.layer || 0) + 1,
            stance: "recognize",
            claim_scope: "interpretation_only",
            reflection_body: proposal.work.reflection,
            evidence_refs: [evidence.bundle_id],
            created_at: finishedAt,
            provenance: {
              origin: "self_reflection",
              recorded_by: run.agent_id,
              trigger_ref: { ref_id: requestEvent.event_id, kind: "event", locator: `events/${requestEvent.event_id}`, observed_at: requestEvent.occurred_at },
            },
          };
          assertProtocol("resignature", resignature, { profile: "0.2" });
        }
      }
    }

    const responseAt = isoTime(this.clock);
    const responseEvent = {
      protocol_version: this.protocolVersion,
      event_id: runScopedId("event", run.run_id, "response"),
      event_type: "agent:message",
      source: run.agent_id,
      target: this.userId,
      occurred_at: responseAt,
      idempotency_key: `${requestEvent.idempotency_key}:response`,
      correlation_id: requestEvent.event_id,
      causation_id: requestEvent.event_id,
      payload: { room_id: run.room_id, run_id: run.run_id, message: proposal.response_text },
    };
    assertProtocol("event", responseEvent);
    const outboxId = runScopedId("outbox", run.run_id, "response");
    const memoryOperations = this.memoryAdapter && memory
      ? [
          {
            operation_id: runScopedId("memory-operation", run.run_id, "reflection"),
            run_id: run.run_id,
            operation_kind: "put_memory",
            max_attempts: this.memoryOperationMaxAttempts,
            payload: { memory: structuredClone(memory) },
            created_at: responseAt,
          },
          ...(resignature ? [{
            operation_id: runScopedId("memory-operation", run.run_id, "resignature"),
            run_id: run.run_id,
            operation_kind: "append_resignature",
            max_attempts: this.memoryOperationMaxAttempts,
            depends_on: runScopedId("memory-operation", run.run_id, "reflection"),
            payload: { expected_previous_id: expectedPreviousResignatureId, resignature: structuredClone(resignature) },
            created_at: responseAt,
          }] : []),
        ]
      : [];
    const result = {
      response_event_id: responseEvent.event_id,
      response_text: proposal.response_text,
      initiative_id: initiative?.initiative_id || null,
      evidence_bundle_id: evidence?.bundle_id || null,
      artifact_ids: artifacts.map((artifact) => artifact.artifact_id),
      memory_id: memory?.memory_id || null,
      resignature_id: resignature?.resignature_id || null,
      memory_operation_ids: memoryOperations.map((operation) => operation.operation_id),
      memory_delivery_status: memory ? (this.memoryAdapter ? "pending" : "delivered") : null,
      outbox_id: outboxId,
    };

    this.store.transaction(() => {
      for (const artifact of artifacts) this.store.saveArtifact(run.run_id, artifact, responseAt);
      if (evidence) this.store.saveEvidence(run.run_id, evidence);
      if (initiative) this.store.saveInitiative(run.run_id, initiative);
      if (memoryDecision) this.store.saveMemoryPolicy(run.run_id, memoryDecision);
      if (this.memoryAdapter) {
        for (const operation of memoryOperations) this.store.enqueueMemoryOperation(operation);
      } else {
        if (memory) this.memoryPort.save(run.run_id, memory);
        if (resignature) this.memoryPort.saveResignature(run.run_id, resignature);
      }
      this.store.insertEvent(responseEvent, run.room_id);
      this.store.enqueueOutbox(run.run_id, outboxId, responseEvent.event_id, responseAt);
      this.store.completeRun(run.run_id, result, responseAt);
    });
    if (memoryOperations.length) await this.drainMemoryOperations({ runId: run.run_id });
    return this.store.getRun(run.run_id)?.result || result;
  }

  async drainMemoryOperations({ runId = null, retryFailed = false } = {}) {
    if (!this.memoryAdapter) return [];
    const startedAt = isoTime(this.clock);
    if (retryFailed) this.store.requeueFailedMemoryOperations(runId, startedAt);
    const operations = this.store.listMemoryOperations({ runId, statuses: ["pending"] });
    const results = [];
    const affectedRuns = new Set();
    for (let operation of operations) {
      affectedRuns.add(operation.run_id);
      if (operation.document.depends_on) {
        const dependency = this.store.getMemoryOperation(operation.document.depends_on);
        if (dependency?.status !== "delivered") {
          results.push({ operation_id: operation.operation_id, status: "blocked" });
          continue;
        }
      }
      try {
        await this.#deliverMemoryOperation(operation);
        operation = this.store.markMemoryOperationDelivered(operation.operation_id, isoTime(this.clock));
        this.#audit(operation.run_id, "memory_operation_delivered", { operation_id: operation.operation_id, operation_kind: operation.operation_kind }, operation.updated_at);
        results.push({ operation_id: operation.operation_id, status: "delivered" });
      } catch (error) {
        if (error?.code === "E_RESIGNATURE_CONFLICT" && operation.operation_kind === "append_resignature") {
          try {
            operation = await this.#rebaseResignatureOperation(operation);
            await this.#deliverMemoryOperation(operation);
            operation = this.store.markMemoryOperationDelivered(operation.operation_id, isoTime(this.clock));
            this.#audit(operation.run_id, "resignature_operation_rebased", { operation_id: operation.operation_id }, operation.updated_at);
            results.push({ operation_id: operation.operation_id, status: "delivered", rebased: true });
            continue;
          } catch (retryError) {
            error = retryError;
          }
        }
        const failed = this.store.recordMemoryOperationFailure(operation.operation_id, error?.code || error?.name || "E_MEMORY_ADAPTER", isoTime(this.clock));
        this.#audit(operation.run_id, "memory_operation_failed", { operation_id: operation.operation_id, operation_kind: operation.operation_kind, error_code: failed.last_error_code, status: failed.status }, failed.updated_at);
        results.push({ operation_id: operation.operation_id, status: failed.status, error_code: failed.last_error_code });
      }
    }
    for (const affectedRunId of affectedRuns) this.#refreshRunMemoryDeliveryStatus(affectedRunId);
    return results;
  }

  async #deliverMemoryOperation(operation) {
    if (operation.operation_kind === "put_memory") {
      return this.memoryAdapter.putMemory({ operationId: operation.operation_id, runId: operation.run_id, memory: structuredClone(operation.document.payload.memory) });
    }
    return this.memoryAdapter.appendResignature({
      operationId: operation.operation_id,
      runId: operation.run_id,
      expectedPreviousId: operation.document.payload.expected_previous_id,
      resignature: structuredClone(operation.document.payload.resignature),
    });
  }

  async #rebaseResignatureOperation(operation) {
    const latest = await this.memoryAdapter.latestResignature({ subjectId: operation.document.payload.resignature.subject_id });
    const resignature = {
      ...structuredClone(operation.document.payload.resignature),
      ...(latest ? { previous_resignature_id: latest.resignature_id } : {}),
      layer: (latest?.layer || 0) + 1,
    };
    if (!latest) delete resignature.previous_resignature_id;
    assertProtocol("resignature", resignature, { profile: "0.2" });
    const document = {
      ...operation.document,
      payload: { expected_previous_id: latest?.resignature_id || null, resignature },
    };
    return this.store.updateMemoryOperationDocument(operation.operation_id, document, isoTime(this.clock));
  }

  #refreshRunMemoryDeliveryStatus(runId) {
    const operations = this.store.listMemoryOperations({ runId, statuses: ["pending", "delivered", "failed"] });
    if (!operations.length) return;
    const status = operations.some((operation) => operation.status === "failed")
      ? "failed"
      : operations.every((operation) => operation.status === "delivered") ? "delivered" : "pending";
    this.store.setRunMemoryDeliveryStatus(runId, status, isoTime(this.clock));
  }

  async #queryMemories(subjectId, limit = 20, options = {}) {
    return this.memoryAdapter
      ? this.memoryAdapter.queryMemories({ subjectId, limit, includeQuarantined: options.includeQuarantined ?? false })
      : this.memoryPort.list(subjectId, limit, options);
  }

  async #latestResignature(subjectId) {
    return this.memoryAdapter
      ? this.memoryAdapter.latestResignature({ subjectId })
      : this.memoryPort.latestResignature(subjectId);
  }

  async drainOutbox(deliver, { retryFailed = false } = {}) {
    if (typeof deliver !== "function") throw new Error("deliver must be a function");
    const results = [];
    const items = [
      ...this.store.listOutbox("pending"),
      ...(retryFailed ? this.store.listOutbox("failed") : []),
    ];
    for (const item of items) {
      const event = this.store.getEvent(item.event_id);
      try {
        await deliver(structuredClone(event));
        const deliveredAt = isoTime(this.clock);
        this.store.markOutbox(item.outbox_id, "delivered", deliveredAt);
        this.#offerFeedback(item.run_id, event, deliveredAt);
        results.push({ outbox_id: item.outbox_id, status: "delivered" });
      } catch (error) {
        this.store.markOutbox(item.outbox_id, "failed", isoTime(this.clock), error.message);
        results.push({ outbox_id: item.outbox_id, status: "failed", error: error.message });
      }
    }
    return results;
  }

  getRun(runId) {
    return publicRun(this.store.getRun(runId));
  }

  getManifest(runId) {
    return this.store.getManifest(runId);
  }

  getInitiative(runId) {
    return this.store.getInitiative(runId);
  }

  getEvidence(runId) {
    return this.store.getEvidence(runId);
  }

  getArtifact(artifactId) {
    return this.store.getArtifact(artifactId);
  }

  readArtifact(artifactId) {
    const artifact = this.store.getArtifact(artifactId);
    if (!artifact) throw new Error(`unknown artifact: ${artifactId}`);
    return this.workspace.readArtifact(artifact.locator);
  }

  async listMemories(subjectId, limit = 20, options = {}) {
    return this.#queryMemories(subjectId, limit, options);
  }

  async listResignatures(subjectId, limit = 20) {
    return this.memoryAdapter
      ? this.memoryAdapter.queryResignatures({ subjectId, limit })
      : this.memoryPort.listResignatures(subjectId, limit);
  }

  listMemoryOperations(options = {}) {
    return this.store.listMemoryOperations({ ...options, statuses: options.statuses || ["pending", "delivered", "failed"] });
  }

  getLifeState(subjectId) {
    return this.store.getLatestLifeState(subjectId);
  }

  listLifecycleRecords(subjectId, kind, limit = 20) {
    if (!new Set(["journal", "dream", "handoff"]).has(kind)) throw new Error("unsupported lifecycle record kind");
    return this.store.listLifecycleRecords(subjectId, kind, limit);
  }

  getAudit(runId) {
    return this.store.listAudit(runId);
  }

  close() {
    if (this.#scheduled.size) throw new Error("cannot close Runtime while Runs are active");
    this.store.close();
  }
}
