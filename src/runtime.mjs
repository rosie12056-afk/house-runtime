import { assertProtocol, protocolProfiles } from "house-protocols";
import { createId, isoTime, runScopedId } from "./ids.mjs";
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
  const allowedKinds = new Set(["event", "message", "memory", "artifact", "source", "claim", "evidence", "lifecycle", "scheduler_lease", "capability_grant", "other"]);
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

  constructor({ dbPath, workspaceDir, instanceId = "instance:fictional-demo", userId = "user:avery", protocolVersion = "0.2", clock = () => new Date(), memoryPolicy = null }) {
    assertString(instanceId, "instanceId", 160);
    assertString(userId, "userId", 160);
    if (!protocolProfiles().includes(protocolVersion)) throw new Error(`unsupported protocolVersion: ${protocolVersion}`);
    this.instanceId = instanceId;
    this.userId = userId;
    this.protocolVersion = protocolVersion;
    this.clock = clock;
    this.memoryPolicy = memoryPolicy;
    this.store = new RuntimeStore(dbPath);
    this.workspace = new Workspace(workspaceDir);
    this.roomQueue = new RoomQueue();
  }

  registerAgent(agentId, adapter) {
    assertString(agentId, "agentId", 160);
    if (!adapter || typeof adapter.generate !== "function") throw new Error("agent adapter must implement generate(input)");
    this.#agents.set(agentId, adapter);
    return this;
  }

  putKeel(keel) {
    assertProtocol("keel", keel);
    this.store.insertKeel(keel);
    return keel;
  }

  getCurrentKeel(subjectId) {
    return this.store.getCurrentKeel(subjectId);
  }

  queueRequest({ roomId, agentId, message, idempotencyKey, contextRefs = [] }) {
    assertString(roomId, "roomId", 160);
    assertString(agentId, "agentId", 160);
    assertString(message, "message", 32000);
    assertString(idempotencyKey, "idempotencyKey", 200);
    if (idempotencyKey.length < 8) throw new Error("idempotencyKey must be at least 8 characters");
    if (!Array.isArray(contextRefs) || contextRefs.length > 32) throw new Error("contextRefs must contain at most 32 references");

    const existingEvent = this.store.findEventByIdempotency(idempotencyKey);
    if (existingEvent) return publicRun(this.store.getRunByRequestEvent(existingEvent.event_id));

    const at = isoTime(this.clock);
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
      created_at: at,
      updated_at: at,
    };
    this.store.transaction(() => {
      this.store.insertEvent(event, roomId);
      this.store.createRun(run);
    });
    return publicRun(this.store.getRun(run.run_id));
  }

  async submit(request) {
    if (!this.#agents.has(request.agentId)) throw new Error(`no adapter registered for ${request.agentId}`);
    const run = this.queueRequest(request);
    return this.executeRun(run.run_id);
  }

  retryRun(runId) {
    const run = this.store.getRun(runId);
    if (!run) return Promise.reject(new Error(`unknown run: ${runId}`));
    if (run.status === "completed") return Promise.resolve(publicRun(run));
    if (run.status === "failed" && !this.store.requeueRun(runId, isoTime(this.clock))) {
      return Promise.reject(new Error(`failed to requeue run: ${runId}`));
    }
    return this.executeRun(runId);
  }

  executeRun(runId) {
    const existing = this.#scheduled.get(runId);
    if (existing) return existing;
    const run = this.store.getRun(runId);
    if (!run) return Promise.reject(new Error(`unknown run: ${runId}`));
    if (run.status === "completed" || run.status === "failed") return Promise.resolve(publicRun(run));
    const scheduled = this.roomQueue.run(run.room_id, () => this.#executeNow(runId)).finally(() => this.#scheduled.delete(runId));
    this.#scheduled.set(runId, scheduled);
    return scheduled;
  }

  async resumePending() {
    return Promise.all(this.store.listPendingRuns().map((run) => this.executeRun(run.run_id)));
  }

  async #executeNow(runId) {
    let run = this.store.getRun(runId);
    if (run.status === "completed" || run.status === "failed") return publicRun(run);
    const adapter = this.#agents.get(run.agent_id);
    if (!adapter) throw new Error(`no adapter registered for ${run.agent_id}`);
    const startedAt = isoTime(this.clock);
    this.store.markRunRunning(runId, startedAt);

    try {
      const event = this.store.getEvent(run.request_event_id);
      const context = this.#buildContext(run, event, startedAt);
      let proposal = this.store.getProposal(runId);
      if (!proposal) {
        proposal = validateProposal(await adapter.generate({
          run: publicRun(this.store.getRun(runId)),
          event: structuredClone(event),
          context: structuredClone(context.adapterContext),
        }));
        this.store.saveProposal(runId, proposal, isoTime(this.clock));
      } else {
        validateProposal(proposal);
      }

      const result = await this.#materialize(run, event, proposal);
      run = this.store.getRun(runId);
      return publicRun(run || { ...run, result });
    } catch (error) {
      const at = isoTime(this.clock);
      this.store.failRun(runId, { name: error.name, message: this.#sanitizeErrorMessage(error.message) }, at);
      return publicRun(this.store.getRun(runId));
    }
  }

  #sanitizeErrorMessage(message) {
    return String(message)
      .replaceAll(this.workspace.root, "<workspace>")
      .replaceAll(this.store.path, "<database>");
  }

  #buildContext(run, event, at) {
    const keel = this.store.getCurrentKeel(run.agent_id);
    const memories = this.store.listMemories(run.agent_id, 20);
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
    const result = {
      response_event_id: responseEvent.event_id,
      response_text: proposal.response_text,
      initiative_id: initiative?.initiative_id || null,
      evidence_bundle_id: evidence?.bundle_id || null,
      artifact_ids: artifacts.map((artifact) => artifact.artifact_id),
      memory_id: memory?.memory_id || null,
      outbox_id: outboxId,
    };

    this.store.transaction(() => {
      for (const artifact of artifacts) this.store.saveArtifact(run.run_id, artifact, responseAt);
      if (evidence) this.store.saveEvidence(run.run_id, evidence);
      if (initiative) this.store.saveInitiative(run.run_id, initiative);
      if (memoryDecision) this.store.saveMemoryPolicy(run.run_id, memoryDecision);
      if (memory) this.store.saveMemory(run.run_id, memory);
      this.store.insertEvent(responseEvent, run.room_id);
      this.store.enqueueOutbox(run.run_id, outboxId, responseEvent.event_id, responseAt);
      this.store.completeRun(run.run_id, result, responseAt);
    });
    return result;
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
        this.store.markOutbox(item.outbox_id, "delivered", isoTime(this.clock));
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

  listMemories(subjectId, limit = 20, options = {}) {
    return this.store.listMemories(subjectId, limit, options);
  }

  close() {
    this.store.close();
  }
}
