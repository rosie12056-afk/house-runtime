import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { HouseRuntime, LifeClock, RuntimeStore, SQLiteMemoryPort } from "../src/index.mjs";
import { runLifecycleConformance, runMigrationConformance, runRuntimeApiConformance } from "house-toolkit/src/conformance.mjs";
import { fictionalMemoryPolicy, lanternAdapter, lanternKeel } from "../demo/fixtures.mjs";

const protocolsRoot = resolve(dirname(fileURLToPath(import.meta.resolve("house-protocols"))), "..");

class ManualTime {
  constructor(value = "2032-04-05T09:00:00.000Z") {
    this.now = Date.parse(value);
    this.nextId = 1;
    this.jobs = new Map();
  }

  clock = () => new Date(this.now);

  setTimeout(callback, milliseconds) {
    const id = this.nextId++;
    this.jobs.set(id, { at: this.now + milliseconds, callback });
    return id;
  }

  clearTimeout(id) {
    this.jobs.delete(id);
  }

  advance(milliseconds) {
    this.now += milliseconds;
    const due = [...this.jobs.entries()].filter(([, job]) => job.at <= this.now).sort((a, b) => a[1].at - b[1].at);
    for (const [id, job] of due) {
      this.jobs.delete(id);
      job.callback();
    }
  }

  set(value) {
    this.now = Date.parse(value);
  }
}

function fictionalSchedule(opportunities) {
  return {
    schedule_id: "schedule:lantern:fictional",
    time_zone: "UTC",
    sleep_window: { start: "22:00", end: "07:00" },
    opportunities: opportunities.map((rule) => ({ max_attempts: 2, retry_delay_minutes: 5, ...rule })),
  };
}

function highRiskGrant() {
  return {
    protocol_version: "0.2",
    grant_id: "grant:fictional:external-write",
    grantee_id: "agent:lantern",
    capability: "external.write",
    scope: { resource_pattern: "fictional://outbox/**", operations: ["create"] },
    risk_tier: "high",
    confirmation_mode: "each_use",
    issued_by: "user:avery",
    issued_at: "2032-04-05T08:00:00.000Z",
    expires_at: "2032-04-06T08:00:00.000Z",
  };
}

function environment(name, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), `house-runtime-${name}-`));
  return {
    root,
    options: {
      dbPath: join(root, "runtime.db"),
      workspaceDir: join(root, "workspace"),
      ...overrides,
    },
  };
}

function allowPolicy(decision = "allow") {
  return {
    decide({ candidate }) {
      return {
        protocol_version: "0.2",
        decision_id: `decision:${candidate.memory_id.slice("memory:".length)}`,
        operation: "write",
        subject_id: candidate.subject_id,
        resource_ref: { ref_id: candidate.memory_id, kind: "memory", locator: `memories/${candidate.memory_id}` },
        source_class: "system_derived",
        decision,
        reason_codes: ["test_policy"],
        evidence_refs: candidate.evidence_refs,
        decided_at: candidate.created_at,
        policy_version: "test-1",
      };
    },
  };
}

test("a durable work run links actual artifacts, evidence, initiative, memory, and outbox", async () => {
  const { options } = environment("durable", { memoryPolicy: fictionalMemoryPolicy() });
  const runtime = new HouseRuntime(options).registerAgent("agent:lantern", lanternAdapter);
  runtime.putKeel(lanternKeel);
  const message = "Write a fictional note without copying this body into the context manifest.";
  const run = await runtime.submit({ roomId: "room:test", agentId: "agent:lantern", message, idempotencyKey: "durable-work-run-1" });

  assert.equal(run.status, "completed");
  assert.equal(run.result.artifact_ids.length, 1);
  assert.match(runtime.readArtifact(run.result.artifact_ids[0]), /Observation:/);
  assert.equal(runtime.getInitiative(run.run_id).status, "completed");
  assert.equal(runtime.getEvidence(run.run_id).claims[0].claim_type, "action_result");
  assert.equal(runtime.getEvidence(run.run_id).protocol_version, "0.2");
  assert.equal(runtime.getManifest(run.run_id).protocol_version, "0.2");
  assert.equal((await runtime.listMemories("agent:lantern")).length, 1);
  assert.equal(runtime.store.listOutbox("pending").length, 1);
  assert.equal(JSON.stringify(runtime.getManifest(run.run_id)).includes(message), false);
  assert.equal(runtime.getManifest(run.run_id).entries.some((entry) => entry.locator.includes("keels/")), true);
  assert.equal(run.result.resignature_id != null, true);
  assert.equal((await runtime.listResignatures("agent:lantern"))[0].claim_scope, "interpretation_only");
  assert.equal(runtime.getAudit(run.run_id).some((event) => event.event_type === "lease_acquired"), true);
  assert.equal(statSync(options.dbPath).mode & 0o777, 0o600);
  runtime.close();
});

test("Life Clock requires explicit schedules and handles an overnight sleep window", () => {
  assert.throws(() => new LifeClock({}), /schedule_id/);
  const clock = new LifeClock(fictionalSchedule([
    { rule_id: "rule:lantern:dream", opportunity_type: "dream", at: "06:30", window_minutes: 30, miss_policy: "offer_on_resume", catch_up_minutes: 120, allowed_states: ["sleeping"] },
    { rule_id: "rule:lantern:tick", opportunity_type: "tick", at: "09:00", window_minutes: 30, miss_policy: "skip", allowed_states: ["awake"] },
  ]));
  assert.equal(clock.stateAt("2032-04-05T23:00:00.000Z"), "sleeping");
  assert.equal(clock.stateAt("2032-04-06T06:35:00.000Z"), "sleeping");
  assert.equal(clock.stateAt("2032-04-06T09:05:00.000Z"), "awake");
  assert.deepEqual(clock.dueWindows("2032-04-06T06:35:00.000Z").map((item) => item.rule.opportunity_type), ["dream"]);
  assert.equal(clock.dueWindows("2032-04-06T07:30:00.000Z")[0].catchUp, true);
});

test("a dream opportunity is agent-owned, non-factual, and restart-idempotent", async () => {
  const time = new ManualTime("2032-04-06T06:35:00.000Z");
  const schedule = fictionalSchedule([
    { rule_id: "rule:lantern:dream", opportunity_type: "dream", at: "06:30", window_minutes: 30, miss_policy: "offer_on_resume", catch_up_minutes: 120, allowed_states: ["sleeping"] },
  ]);
  const { options } = environment("dream-lifecycle", { clock: time.clock });
  let calls = 0;
  const lifecycleAdapter = {
    async consider(input) {
      calls += 1;
      assert.equal("prompt" in input, false);
      return {
        decision: "accept",
        reason_codes: ["agent_chose_to_record"],
        outcome: {
          type: "dream",
          content: {
            body: "Two fictional fragments changed order without claiming that the scene occurred.",
            fragment_refs: [],
            affect_words: ["unfinished"],
          },
        },
      };
    },
  };
  let runtime = new HouseRuntime(options).registerLifecycle("agent:lantern", { schedule, adapter: lifecycleAdapter });
  const first = await runtime.pollLifecycle("agent:lantern");
  assert.equal(first[0].status, "accepted");
  assert.equal(runtime.getLifeState("agent:lantern").state, "sleeping");
  assert.equal(runtime.listLifecycleRecords("agent:lantern", "dream")[0].factuality, "non_factual");
  runtime.close();

  runtime = new HouseRuntime(options).registerLifecycle("agent:lantern", { schedule, adapter: lifecycleAdapter });
  assert.deepEqual(await runtime.pollLifecycle("agent:lantern"), []);
  assert.equal(runtime.store.count("lifecycle_records"), 1);
  assert.equal(calls, 1);
  runtime.close();
});

test("an unsupported journal observation remains offered and is not persisted", async () => {
  const time = new ManualTime("2032-04-05T20:05:00.000Z");
  const schedule = fictionalSchedule([
    { rule_id: "rule:lantern:journal", opportunity_type: "journal", at: "20:00", window_minutes: 30, miss_policy: "offer_on_resume", catch_up_minutes: 60, allowed_states: ["awake"] },
  ]);
  const { options } = environment("journal-boundary", { clock: time.clock });
  const runtime = new HouseRuntime(options).registerLifecycle("agent:lantern", {
    schedule,
    adapter: {
      async consider() {
        return {
          decision: "accept",
          reason_codes: ["agent_chose_to_record"],
          outcome: {
            type: "journal",
            content: {
              events: [{ statement: "An unsupported event occurred.", epistemic_status: "observed", source_refs: [], evidence_refs: [] }],
              reflections: [],
              intentions: [],
            },
          },
        };
      },
    },
  });
  const result = await runtime.pollLifecycle("agent:lantern");
  assert.equal(result[0].status, "offered");
  assert.deepEqual(await runtime.pollLifecycle("agent:lantern"), []);
  time.advance(5 * 60000);
  const exhausted = await runtime.pollLifecycle("agent:lantern");
  assert.equal(exhausted[0].status, "declined");
  assert.equal(runtime.store.count("lifecycle_records"), 0);
  runtime.close();
});

test("tick work closes through artifact, Evidence, delivery, and agent-authored feedback", async () => {
  const time = new ManualTime("2032-04-05T09:05:00.000Z");
  const schedule = fictionalSchedule([
    { rule_id: "rule:lantern:tick", opportunity_type: "tick", at: "09:00", window_minutes: 30, miss_policy: "skip", allowed_states: ["awake"] },
  ]);
  const { options } = environment("initiative-loop", { clock: time.clock, memoryPolicy: fictionalMemoryPolicy() });
  const lifecycleAdapter = {
    async consider({ opportunity }) {
      if (opportunity.opportunity_type === "tick") {
        return {
          decision: "accept",
          reason_codes: ["agent_selected_work"],
          outcome: { type: "initiative", content: { room_id: "room:studio", message: "Create the fictional field note selected from this opportunity." } },
        };
      }
      const evidence = opportunity.source_refs.find((reference) => reference.kind === "evidence");
      const event = opportunity.source_refs.find((reference) => reference.kind === "event");
      return {
        decision: "accept",
        reason_codes: ["agent_reflected_after_delivery"],
        outcome: {
          type: "journal",
          content: {
            events: [{ statement: "The Runtime delivered the selected work.", epistemic_status: "observed", source_refs: [event], evidence_refs: [evidence.ref_id] }],
            reflections: [{ body: "Delivery changed the initiative from an intention into a reviewable result.", source_refs: [evidence] }],
            intentions: [{ body: "Wait for substantive feedback before revising the result.", status: "open" }],
          },
        },
      };
    },
  };
  const runtime = new HouseRuntime(options)
    .registerAgent("agent:lantern", lanternAdapter)
    .registerLifecycle("agent:lantern", { schedule, adapter: lifecycleAdapter });
  const tick = await runtime.pollLifecycle("agent:lantern");
  assert.equal(tick[0].response_kind, "initiative");
  assert.equal(runtime.store.count("initiatives"), 1);
  assert.equal(runtime.store.count("evidence_bundles"), 1);
  await runtime.drainOutbox(() => undefined);
  const feedback = await runtime.pollLifecycle("agent:lantern");
  assert.equal(feedback[0].response_kind, "journal");
  assert.equal(runtime.listLifecycleRecords("agent:lantern", "journal").length, 1);
  runtime.close();
});

test("sleep transitions and handoff records remain distinct from dreams", async () => {
  const time = new ManualTime("2032-04-05T21:55:00.000Z");
  const schedule = fictionalSchedule([
    { rule_id: "rule:lantern:handoff", opportunity_type: "handoff", at: "21:50", window_minutes: 10, miss_policy: "offer_on_resume", catch_up_minutes: 30, allowed_states: ["awake"] },
  ]);
  const { options } = environment("handoff", { clock: time.clock });
  const runtime = new HouseRuntime(options).registerLifecycle("agent:lantern", {
    schedule,
    adapter: {
      async consider() {
        return {
          decision: "accept",
          reason_codes: ["agent_chose_handoff"],
          outcome: { type: "handoff", content: { open_initiative_refs: [], completed_initiative_refs: [], unresolved_questions: ["What should be revisited after waking?"], source_refs: [] } },
        };
      },
    },
  });
  await runtime.pollLifecycle("agent:lantern");
  const awake = runtime.getLifeState("agent:lantern");
  time.set("2032-04-05T22:05:00.000Z");
  await runtime.pollLifecycle("agent:lantern");
  const sleeping = runtime.getLifeState("agent:lantern");
  assert.equal(awake.state, "awake");
  assert.equal(sleeping.state, "sleeping");
  assert.equal(sleeping.previous_state_id, awake.state_id);
  assert.equal(runtime.listLifecycleRecords("agent:lantern", "handoff").length, 1);
  assert.equal(runtime.listLifecycleRecords("agent:lantern", "dream").length, 0);
  runtime.close();
});

test("high-risk work waits for host-authenticated confirmation and survives a rejected credential", async () => {
  const time = new ManualTime();
  let calls = 0;
  const { options } = environment("confirmation", {
    clock: time.clock,
    confirmationVerifier({ authentication }) {
      if (authentication?.session !== "verified") throw new Error("authentication failed");
      return { subject_id: "user:avery" };
    },
  });
  const runtime = new HouseRuntime(options).registerAgent("agent:lantern", { async generate() { calls += 1; return { response_text: "Confirmed." }; } });
  const waiting = await runtime.submit({ roomId: "room:test", agentId: "agent:lantern", message: "External action.", idempotencyKey: "confirmation-required", capabilityGrant: highRiskGrant() });
  assert.equal(waiting.status, "waiting_confirmation");
  assert.equal(calls, 0);
  await assert.rejects(runtime.resolveConfirmation({ confirmationId: waiting.confirmation_id, decision: "approve", authentication: { session: "forged" } }), /authentication failed/);
  assert.equal(runtime.getRun(waiting.run_id).status, "waiting_confirmation");
  const completed = await runtime.resolveConfirmation({ confirmationId: waiting.confirmation_id, decision: "approve", authentication: { session: "verified" } });
  assert.equal(completed.status, "completed");
  assert.equal(calls, 1);
  runtime.close();
});

test("confirmation challenges cannot be resolved when the host has no verifier", async () => {
  const time = new ManualTime();
  const { options } = environment("confirmation-no-verifier", { clock: time.clock });
  const runtime = new HouseRuntime(options).registerAgent("agent:lantern", { async generate() { return { response_text: "Must not run." }; } });
  const waiting = await runtime.submit({ roomId: "room:test", agentId: "agent:lantern", message: "External action.", idempotencyKey: "confirmation-no-verifier", capabilityGrant: highRiskGrant() });
  await assert.rejects(runtime.resolveConfirmation({ confirmationId: waiting.confirmation_id, decision: "approve", authentication: {} }), /confirmationVerifier is required/);
  runtime.close();
});

test("a pending confirmation survives restart without running the adapter", async () => {
  const time = new ManualTime();
  const verifier = ({ authentication }) => {
    if (authentication?.session !== "verified") throw new Error("authentication failed");
    return { subject_id: "user:avery" };
  };
  const { options } = environment("confirmation-restart", { clock: time.clock, confirmationVerifier: verifier });
  let runtime = new HouseRuntime(options).registerAgent("agent:lantern", { async generate() { throw new Error("first process must not generate"); } });
  const waiting = await runtime.submit({ roomId: "room:test", agentId: "agent:lantern", message: "External action.", idempotencyKey: "confirmation-restart", capabilityGrant: highRiskGrant() });
  runtime.close();

  runtime = new HouseRuntime(options).registerAgent("agent:lantern", { async generate() { return { response_text: "Confirmed after restart." }; } });
  assert.equal(runtime.getRun(waiting.run_id).status, "waiting_confirmation");
  const completed = await runtime.resolveConfirmation({ confirmationId: waiting.confirmation_id, decision: "approve", authentication: { session: "verified" } });
  assert.equal(completed.status, "completed");
  runtime.close();
});

test("a running adapter can be cancelled before any materialization", async () => {
  const { options } = environment("cancel");
  const runtime = new HouseRuntime(options).registerAgent("agent:lantern", { async generate() { return new Promise(() => {}); } });
  const queued = runtime.queueRequest({ roomId: "room:test", agentId: "agent:lantern", message: "Wait.", idempotencyKey: "cancel-running-adapter" });
  const execution = runtime.executeRun(queued.run_id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.cancelRun(queued.run_id).status, "cancelled");
  assert.equal((await execution).status, "cancelled");
  assert.equal(runtime.store.count("artifacts"), 0);
  assert.equal(runtime.getAudit(queued.run_id).filter((event) => event.event_type === "run_cancelled").length, 1);
  runtime.close();
});

test("fake time deterministically triggers a timeout", async () => {
  const time = new ManualTime();
  const { options } = environment("timeout", { clock: time.clock, timer: time, defaultTimeoutMs: 50 });
  const runtime = new HouseRuntime(options).registerAgent("agent:lantern", { async generate() { return new Promise(() => {}); } });
  const execution = runtime.submit({ roomId: "room:test", agentId: "agent:lantern", message: "Timeout.", idempotencyKey: "fake-clock-timeout" });
  await new Promise((resolve) => setImmediate(resolve));
  time.advance(50);
  const run = await execution;
  assert.equal(run.status, "timed_out");
  assert.equal(run.error.name, "ExecutionTimeoutError");
  assert.equal(runtime.getAudit(run.run_id).some((event) => event.event_type === "run_timed_out"), true);
  runtime.close();
});

test("retry budgets stop repeated failed execution", async () => {
  const { options } = environment("retry-budget");
  const runtime = new HouseRuntime(options).registerAgent("agent:lantern", { async generate() { throw new Error("repeat failure"); } });
  const first = await runtime.submit({ roomId: "room:test", agentId: "agent:lantern", message: "Fail.", idempotencyKey: "retry-budget-test", maxAttempts: 2 });
  const second = await runtime.retryRun(first.run_id);
  assert.equal(second.status, "failed");
  assert.equal(second.attempts, 2);
  await assert.rejects(runtime.retryRun(first.run_id), /failed to requeue run/);
  runtime.close();
});

test("an unexpired scheduler lease blocks a second runtime and expires under fake time", async () => {
  const time = new ManualTime();
  const { options } = environment("lease-expiry", { clock: time.clock });
  let first = new HouseRuntime({ ...options, runtimeId: "runtime:dead" });
  const queued = first.queueRequest({ roomId: "room:test", agentId: "agent:lantern", message: "Resume after lease.", idempotencyKey: "lease-expiry-test" });
  first.store.acquireLease({
    protocol_version: "0.2",
    lease_id: "lease:fictional:crashed",
    run_id: queued.run_id,
    work_ref: { ref_id: queued.run_id, kind: "other", locator: `runs/${queued.run_id}` },
    holder_id: "runtime:dead",
    status: "active",
    acquired_at: time.clock().toISOString(),
    expires_at: new Date(time.now + 1000).toISOString(),
  });
  first.close();

  const second = new HouseRuntime({ ...options, runtimeId: "runtime:recovery" }).registerAgent("agent:lantern", { async generate() { return { response_text: "Recovered." }; } });
  assert.equal((await second.executeRun(queued.run_id)).status, "queued");
  time.advance(1001);
  assert.equal((await second.executeRun(queued.run_id)).status, "completed");
  second.close();
});

test("opening a second live Runtime does not reset another holder's running attempt", async () => {
  const { options } = environment("live-lease-holder");
  const first = new HouseRuntime({ ...options, runtimeId: "runtime:first" }).registerAgent("agent:lantern", { async generate() { return new Promise(() => {}); } });
  const queued = first.queueRequest({ roomId: "room:test", agentId: "agent:lantern", message: "Stay active.", idempotencyKey: "live-lease-holder" });
  const execution = first.executeRun(queued.run_id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.getRun(queued.run_id).status, "running");
  assert.equal(first.getRun(queued.run_id).attempts, 1);

  const second = new HouseRuntime({ ...options, runtimeId: "runtime:second" }).registerAgent("agent:lantern", { async generate() { throw new Error("lease must block this adapter"); } });
  const blocked = await second.executeRun(queued.run_id);
  assert.equal(blocked.status, "running");
  assert.equal(blocked.attempts, 1);
  first.cancelRun(queued.run_id);
  await execution;
  first.close();
  second.close();
});

test("resignatures form an append-only interpretation chain", async () => {
  const { options } = environment("resignature", { memoryPolicy: fictionalMemoryPolicy() });
  const runtime = new HouseRuntime(options).registerAgent("agent:lantern", lanternAdapter);
  await runtime.submit({ roomId: "room:test", agentId: "agent:lantern", message: "First reflection.", idempotencyKey: "resignature-first" });
  await runtime.submit({ roomId: "room:test", agentId: "agent:lantern", message: "Second reflection.", idempotencyKey: "resignature-second" });
  const records = await runtime.listResignatures("agent:lantern");
  assert.deepEqual(records.map((item) => item.layer), [2, 1]);
  assert.equal(records[0].previous_resignature_id, records[1].resignature_id);
  runtime.close();
});

test("the explicit Memory Port is used for reads, memories, and resignatures", async () => {
  const { options } = environment("memory-port");
  let base;
  const calls = [];
  const memoryPort = {
    list(...args) { calls.push("list"); return base.list(...args); },
    save(...args) { calls.push("save"); return base.save(...args); },
    saveResignature(...args) { calls.push("saveResignature"); return base.saveResignature(...args); },
    latestResignature(...args) { calls.push("latestResignature"); return base.latestResignature(...args); },
    listResignatures(...args) { calls.push("listResignatures"); return base.listResignatures(...args); },
  };
  const runtime = new HouseRuntime({ ...options, memoryPort, memoryPolicy: fictionalMemoryPolicy() });
  base = new SQLiteMemoryPort(runtime.store);
  runtime.registerAgent("agent:lantern", lanternAdapter);
  await runtime.submit({ roomId: "room:test", agentId: "agent:lantern", message: "Use port.", idempotencyKey: "memory-port-test" });
  await runtime.listResignatures("agent:lantern");
  assert.equal(new Set(calls).size, 5);
  runtime.close();
});

test("a schema version 1 database upgrades forward without rebuilding runs", () => {
  const root = mkdtempSync(join(tmpdir(), "house-runtime-migration-"));
  const path = join(root, "runtime.db");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO runtime_meta VALUES ('schema_version', '1'); CREATE TABLE runs (run_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, agent_id TEXT NOT NULL, request_event_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed')), result_json TEXT, error_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO runs VALUES ('run:legacy:1', 'room:legacy', 'agent:lantern', 'event:legacy:1', 'queued', NULL, NULL, '2032-04-05T09:00:00.000Z', '2032-04-05T09:00:00.000Z');");
  old.close();
  const store = new RuntimeStore(path);
  const columns = store.db.prepare("PRAGMA table_info(runs)").all().map((item) => item.name);
  assert.equal(columns.includes("attempts"), true);
  assert.equal(columns.includes("max_attempts"), true);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM run_controls WHERE run_id = 'run:legacy:1'").get().count, 1);
  assert.equal(store.db.prepare("SELECT value FROM runtime_meta WHERE key = 'schema_version'").get().value, "4");
  store.close();
});

test("a newer database schema is rejected instead of silently downgraded", () => {
  const root = mkdtempSync(join(tmpdir(), "house-runtime-future-schema-"));
  const path = join(root, "runtime.db");
  const future = new DatabaseSync(path);
  future.exec("CREATE TABLE runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO runtime_meta VALUES ('schema_version', '9');");
  future.close();
  assert.throws(() => new RuntimeStore(path), /newer than supported schema 4/);
});

test("an alpha.2 schema upgrades through lifecycle to memory-operation schema 4", () => {
  const root = mkdtempSync(join(tmpdir(), "house-runtime-schema-two-"));
  const path = join(root, "runtime.db");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO runtime_meta VALUES ('schema_version', '2'); CREATE TABLE runs (run_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, agent_id TEXT NOT NULL, request_event_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed')), result_json TEXT, error_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3);");
  old.close();
  const store = new RuntimeStore(path);
  assert.equal(store.db.prepare("SELECT value FROM runtime_meta WHERE key = 'schema_version'").get().value, "4");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'lifecycle_opportunities'").get().count, 1);
  store.close();
});

test("Runtime passes the shared v0.1-to-v0.2 migration fixture set", () => {
  const report = runMigrationConformance(join(protocolsRoot, "fixtures", "migrations", "v0.1-to-v0.2.json"));
  assert.equal(report.ok, true);
  assert.equal(report.summary.records_checked, 7);
});

test("Runtime passes the shared lifecycle fixture set", () => {
  const report = runLifecycleConformance(join(protocolsRoot, "fixtures", "v0.2", "lifecycle-contracts.json"));
  assert.equal(report.ok, true);
  assert.equal(report.summary.records_checked, 5);
});

test("Runtime passes the shared transport-neutral API fixture set", () => {
  const report = runRuntimeApiConformance(join(protocolsRoot, "fixtures", "v0.2", "runtime-api.json"));
  assert.equal(report.ok, true);
  assert.equal(report.summary.records_checked, 4);
});

test("stored v0.1 events remain readable after new writes move to v0.2", async () => {
  const { options } = environment("protocol-upgrade");
  let runtime = new HouseRuntime({ ...options, protocolVersion: "0.1" }).registerAgent("agent:lantern", { async generate() { return { response_text: "Old profile." }; } });
  const oldRun = await runtime.submit({ roomId: "room:test", agentId: "agent:lantern", message: "Old.", idempotencyKey: "protocol-old-record" });
  const oldEventId = runtime.getRun(oldRun.run_id).request_event_id;
  assert.equal(runtime.store.getEvent(oldEventId).protocol_version, "0.1");
  runtime.close();

  runtime = new HouseRuntime(options).registerAgent("agent:lantern", { async generate() { return { response_text: "New profile." }; } });
  assert.equal(runtime.store.getEvent(oldEventId).protocol_version, "0.1");
  const newRun = await runtime.submit({ roomId: "room:test", agentId: "agent:lantern", message: "New.", idempotencyKey: "protocol-new-record" });
  assert.equal(runtime.store.getEvent(runtime.getRun(newRun.run_id).request_event_id).protocol_version, "0.2");
  runtime.close();
});

test("idempotent submission reuses one event, run, and adapter proposal", async () => {
  const { options } = environment("idempotency");
  let calls = 0;
  const runtime = new HouseRuntime(options).registerAgent("agent:lantern", {
    async generate() {
      calls += 1;
      return { response_text: "One durable response." };
    },
  });
  const request = { roomId: "room:test", agentId: "agent:lantern", message: "Hello.", idempotencyKey: "same-request-key-1" };
  const first = await runtime.submit(request);
  const second = await runtime.submit(request);
  assert.equal(first.run_id, second.run_id);
  assert.equal(calls, 1);
  assert.equal(runtime.store.count("runs"), 1);
  assert.equal(runtime.store.count("events"), 2);
  runtime.close();
});

test("same-room generations are serialized", async () => {
  const { options } = environment("room-queue");
  let active = 0;
  let maximum = 0;
  const adapter = {
    async generate() {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return { response_text: "Queued response." };
    },
  };
  const runtime = new HouseRuntime(options).registerAgent("agent:lantern", adapter);
  await Promise.all([
    runtime.submit({ roomId: "room:one", agentId: "agent:lantern", message: "First.", idempotencyKey: "room-queue-first" }),
    runtime.submit({ roomId: "room:one", agentId: "agent:lantern", message: "Second.", idempotencyKey: "room-queue-second" }),
  ]);
  assert.equal(maximum, 1);
  runtime.close();
});

test("different rooms can generate concurrently", async () => {
  const { options } = environment("room-parallel");
  let active = 0;
  let maximum = 0;
  const adapter = {
    async generate() {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return { response_text: "Parallel response." };
    },
  };
  const runtime = new HouseRuntime(options).registerAgent("agent:lantern", adapter);
  await Promise.all([
    runtime.submit({ roomId: "room:one", agentId: "agent:lantern", message: "First room.", idempotencyKey: "room-parallel-first" }),
    runtime.submit({ roomId: "room:two", agentId: "agent:lantern", message: "Second room.", idempotencyKey: "room-parallel-second" }),
  ]);
  assert.equal(maximum, 2);
  runtime.close();
});

test("a queued run resumes after restart", async () => {
  const { options } = environment("restart-queued");
  let runtime = new HouseRuntime(options);
  const queued = runtime.queueRequest({ roomId: "room:test", agentId: "agent:lantern", message: "Resume me.", idempotencyKey: "restart-queued-run" });
  runtime.close();

  runtime = new HouseRuntime(options).registerAgent("agent:lantern", { async generate() { return { response_text: "Resumed." }; } });
  const [resumed] = await runtime.resumePending();
  assert.equal(resumed.run_id, queued.run_id);
  assert.equal(resumed.status, "completed");
  runtime.close();
});

test("a persisted proposal is reused after an interrupted run", async () => {
  const { options } = environment("restart-proposal");
  let runtime = new HouseRuntime(options);
  const queued = runtime.queueRequest({ roomId: "room:test", agentId: "agent:lantern", message: "Use saved proposal.", idempotencyKey: "restart-saved-proposal" });
  runtime.store.saveProposal(queued.run_id, { response_text: "Recovered without regeneration." }, new Date().toISOString());
  runtime.store.markRunRunning(queued.run_id, new Date().toISOString());
  runtime.close();

  runtime = new HouseRuntime(options).registerAgent("agent:lantern", { async generate() { throw new Error("adapter must not be called"); } });
  const [resumed] = await runtime.resumePending();
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.result.response_text, "Recovered without regeneration.");
  runtime.close();
});

test("a failed run can retry from its persisted proposal without regenerating", async () => {
  let policyCalls = 0;
  const memoryPolicy = {
    decide({ candidate }) {
      policyCalls += 1;
      if (policyCalls === 1) throw new Error("temporary policy failure");
      return {
        protocol_version: "0.2",
        decision_id: `decision:${candidate.memory_id.slice("memory:".length)}`,
        operation: "write",
        subject_id: candidate.subject_id,
        resource_ref: { ref_id: candidate.memory_id, kind: "memory", locator: `memories/${candidate.memory_id}` },
        source_class: "system_derived",
        decision: "allow",
        reason_codes: ["retry_test"],
        evidence_refs: candidate.evidence_refs,
        decided_at: candidate.created_at,
        policy_version: "test-1",
      };
    },
  };
  const { options } = environment("retry", { memoryPolicy });
  let adapterCalls = 0;
  const runtime = new HouseRuntime(options).registerAgent("agent:lantern", {
    async generate(input) {
      adapterCalls += 1;
      return lanternAdapter.generate(input);
    },
  });
  const failed = await runtime.submit({ roomId: "room:test", agentId: "agent:lantern", message: "Retry policy.", idempotencyKey: "retry-policy-run" });
  assert.equal(failed.status, "failed");
  const retried = await runtime.retryRun(failed.run_id);
  assert.equal(retried.status, "completed");
  assert.equal(adapterCalls, 1);
  assert.equal(policyCalls, 2);
  runtime.close();
});

test("Keel revisions are immutable and the newest revision is selected", () => {
  const { options } = environment("keel");
  const runtime = new HouseRuntime(options);
  runtime.putKeel(lanternKeel);
  assert.throws(() => runtime.putKeel(lanternKeel), /UNIQUE constraint failed/);
  runtime.putKeel({ ...lanternKeel, revision: 2, created_at: "2032-04-06T09:00:00.000Z", grounding_statement: "A later fictional revision." });
  assert.equal(runtime.getCurrentKeel("agent:lantern").revision, 2);
  runtime.close();
});

test("memory is not written without an allow or quarantine decision", async () => {
  const { options } = environment("memory-deny", { memoryPolicy: allowPolicy("deny") });
  const runtime = new HouseRuntime(options).registerAgent("agent:lantern", lanternAdapter);
  const run = await runtime.submit({ roomId: "room:test", agentId: "agent:lantern", message: "Do work.", idempotencyKey: "memory-policy-deny" });
  assert.equal(run.status, "completed");
  assert.equal(run.result.memory_id, null);
  assert.equal((await runtime.listMemories("agent:lantern")).length, 0);
  runtime.close();
});

test("artifact traversal fails the run and writes nothing outside the workspace", async () => {
  const { root, options } = environment("traversal");
  const runtime = new HouseRuntime(options).registerAgent("agent:lantern", {
    async generate() {
      return {
        response_text: "Unsafe proposal.",
        work: { goal: "Attempt an unsafe artifact.", artifacts: [{ path: "../outside.txt", content: "unsafe" }] },
      };
    },
  });
  const run = await runtime.submit({ roomId: "room:test", agentId: "agent:lantern", message: "Try path traversal.", idempotencyKey: "artifact-traversal-test" });
  assert.equal(run.status, "failed");
  assert.match(run.error.message, /escapes the workspace/);
  assert.equal(existsSync(join(root, "outside.txt")), false);
  runtime.close();
});

test("outbox delivery state survives restart", async () => {
  const { options } = environment("outbox");
  let runtime = new HouseRuntime(options).registerAgent("agent:lantern", { async generate() { return { response_text: "Deliver later." }; } });
  await runtime.submit({ roomId: "room:test", agentId: "agent:lantern", message: "Queue response.", idempotencyKey: "outbox-restart-test" });
  runtime.close();

  runtime = new HouseRuntime(options);
  assert.equal(runtime.store.listOutbox("pending").length, 1);
  const delivered = [];
  const results = await runtime.drainOutbox((event) => delivered.push(event.event_id));
  assert.equal(results[0].status, "delivered");
  assert.equal(delivered.length, 1);
  assert.equal(runtime.store.listOutbox("delivered").length, 1);
  runtime.close();
});

test("a failed outbox item is retried only when explicitly requested", async () => {
  const { options } = environment("outbox-retry");
  const runtime = new HouseRuntime(options).registerAgent("agent:lantern", { async generate() { return { response_text: "Retry delivery." }; } });
  await runtime.submit({ roomId: "room:test", agentId: "agent:lantern", message: "Queue response.", idempotencyKey: "outbox-retry-test" });
  await runtime.drainOutbox(() => { throw new Error("temporary sink failure"); });
  assert.equal(runtime.store.listOutbox("failed").length, 1);
  assert.equal((await runtime.drainOutbox(() => undefined)).length, 0);
  const retried = await runtime.drainOutbox(() => undefined, { retryFailed: true });
  assert.equal(retried[0].status, "delivered");
  assert.equal(runtime.store.listOutbox("delivered").length, 1);
  runtime.close();
});

test("adapter proposals cannot smuggle completion fields", async () => {
  const { options } = environment("proposal-fields");
  const runtime = new HouseRuntime(options).registerAgent("agent:lantern", {
    async generate() {
      return { response_text: "Attempted override.", status: "completed" };
    },
  });
  const run = await runtime.submit({ roomId: "room:test", agentId: "agent:lantern", message: "Do not trust adapter status.", idempotencyKey: "proposal-field-test" });
  assert.equal(run.status, "failed");
  assert.match(run.error.message, /unsupported field: status/);
  runtime.close();
});

test("persisted errors redact configured database and workspace paths", async () => {
  const { options } = environment("error-redaction");
  const runtime = new HouseRuntime(options).registerAgent("agent:lantern", {
    async generate() {
      throw new Error(`failed near ${options.workspaceDir} and ${options.dbPath}`);
    },
  });
  const run = await runtime.submit({ roomId: "room:test", agentId: "agent:lantern", message: "Redact paths.", idempotencyKey: "error-redaction-test" });
  assert.equal(run.status, "failed");
  assert.equal(run.error.message.includes(options.workspaceDir), false);
  assert.equal(run.error.message.includes(options.dbPath), false);
  assert.match(run.error.message, /<workspace>/);
  assert.match(run.error.message, /<database>/);
  runtime.close();
});
