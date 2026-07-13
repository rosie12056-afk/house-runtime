import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HouseRuntime } from "../src/index.mjs";
import { fictionalMemoryPolicy, lanternAdapter, lanternKeel } from "../demo/fixtures.mjs";

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
        protocol_version: "0.1",
        decision_id: `decision:${candidate.memory_id.slice("memory:".length)}`,
        operation: "write",
        subject_id: candidate.subject_id,
        resource_ref: { ref_id: candidate.memory_id, kind: "memory", locator: `memories/${candidate.memory_id}` },
        decision,
        reason_codes: ["test_policy"],
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
  assert.equal(runtime.listMemories("agent:lantern").length, 1);
  assert.equal(runtime.store.listOutbox("pending").length, 1);
  assert.equal(JSON.stringify(runtime.getManifest(run.run_id)).includes(message), false);
  assert.equal(runtime.getManifest(run.run_id).entries.some((entry) => entry.locator.includes("keels/")), true);
  assert.equal(statSync(options.dbPath).mode & 0o777, 0o600);
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
        protocol_version: "0.1",
        decision_id: `decision:${candidate.memory_id.slice("memory:".length)}`,
        operation: "write",
        subject_id: candidate.subject_id,
        resource_ref: { ref_id: candidate.memory_id, kind: "memory", locator: `memories/${candidate.memory_id}` },
        decision: "allow",
        reason_codes: ["retry_test"],
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
  assert.equal(runtime.listMemories("agent:lantern").length, 0);
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
