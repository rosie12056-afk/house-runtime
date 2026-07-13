import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runMemoryPortConformance } from "house-toolkit/src/conformance.mjs";
import { assertMemoryPortCandidate, HouseRuntime, JsonFileMemoryAdapter, migrateEmbeddedMemory, SQLiteMemoryAdapter } from "../src/index.mjs";
import { fictionalMemoryPolicy, lanternAdapter } from "../demo/fixtures.mjs";

function adapterHarness(Adapter, filename) {
  const root = mkdtempSync(join(tmpdir(), "house-runtime-memory-port-"));
  const path = join(root, filename);
  return {
    path,
    createPort: async () => assertMemoryPortCandidate(new Adapter(path)),
    reopenPort: async () => assertMemoryPortCandidate(new Adapter(path)),
    closePort: async (port) => port.close(),
  };
}

for (const [name, Adapter, filename] of [
  ["SQLite", SQLiteMemoryAdapter, "memory.db"],
  ["JSON file", JsonFileMemoryAdapter, "memory.json"],
]) {
  test(`${name} Memory Adapter passes the independent candidate suite`, async () => {
    const harness = adapterHarness(Adapter, filename);
    const report = await runMemoryPortConformance(harness);
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(statSync(harness.path).mode & 0o777, 0o600);
  });
}

test("independent adapters reject operation-id reuse with changed content", async () => {
  for (const [Adapter, filename] of [[SQLiteMemoryAdapter, "memory.db"], [JsonFileMemoryAdapter, "memory.json"]]) {
    const { path } = adapterHarness(Adapter, filename);
    const adapter = new Adapter(path);
    const input = {
      operationId: "memory-operation:reuse",
      runId: "run:fictional:reuse",
      memory: {
        memory_id: "memory:fictional:reuse",
        subject_id: "agent:lantern",
        kind: "reflection",
        body: "Original fictional body.",
        source_refs: [],
        evidence_refs: [],
        status: "active",
        created_at: "2032-04-05T09:00:00.000Z",
      },
    };
    await adapter.putMemory(input);
    await assert.rejects(adapter.putMemory({ ...input, memory: { ...input.memory, body: "Changed fictional body." } }), { code: "E_MEMORY_OPERATION_CONFLICT" });
    adapter.close();
  }
});

test("two adapter instances cannot append different Resignatures to the same head", async () => {
  for (const [Adapter, filename] of [[SQLiteMemoryAdapter, "memory.db"], [JsonFileMemoryAdapter, "memory.json"]]) {
    const { path } = adapterHarness(Adapter, filename);
    const first = new Adapter(path);
    const second = new Adapter(path);
    const base = {
      protocol_version: "0.2",
      subject_id: "agent:lantern",
      source_ref: { ref_id: "event:fictional:race", kind: "event", locator: "events/fictional-race" },
      layer: 1,
      stance: "uncertain",
      claim_scope: "interpretation_only",
      reflection_body: "A fictional concurrent interpretation.",
      evidence_refs: ["evidence:fictional:race"],
      created_at: "2032-04-05T09:00:00.000Z",
      provenance: { origin: "self_reflection", recorded_by: "agent:lantern" },
    };
    const attempts = await Promise.allSettled([
      first.appendResignature({ operationId: "resignature-operation:race-one", runId: "run:fictional:race-one", expectedPreviousId: null, resignature: { ...base, resignature_id: "resignature:fictional:race-one" } }),
      second.appendResignature({ operationId: "resignature-operation:race-two", runId: "run:fictional:race-two", expectedPreviousId: null, resignature: { ...base, resignature_id: "resignature:fictional:race-two" } }),
    ]);
    assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((item) => item.status === "rejected" && item.reason?.code === "E_RESIGNATURE_CONFLICT").length, 1);
    first.close();
    second.close();
  }
});

test("Runtime delivers memory and Resignature through a standalone asynchronous adapter", async () => {
  const root = mkdtempSync(join(tmpdir(), "house-runtime-memory-integration-"));
  const adapter = new JsonFileMemoryAdapter(join(root, "memory.json"));
  const runtime = new HouseRuntime({
    dbPath: join(root, "runtime.db"),
    workspaceDir: join(root, "workspace"),
    memoryAdapter: adapter,
    memoryPolicy: fictionalMemoryPolicy(),
  }).registerAgent("agent:lantern", lanternAdapter);
  const run = await runtime.submit({ roomId: "room:fictional", agentId: "agent:lantern", message: "Store through the standalone adapter.", idempotencyKey: "standalone-memory" });
  assert.equal(run.result.memory_delivery_status, "delivered");
  assert.equal(runtime.store.count("memories"), 0);
  assert.equal(runtime.store.count("resignatures"), 0);
  assert.equal(runtime.store.count("memory_operations"), 2);
  assert.equal(runtime.listMemoryOperations().every((item) => item.status === "delivered"), true);
  assert.equal((await runtime.listMemories("agent:lantern")).length, 1);
  assert.equal((await runtime.listResignatures("agent:lantern")).length, 1);
  runtime.close();
  adapter.close();
});

test("a failed adapter write remains durable and resumes after Runtime restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "house-runtime-memory-restart-"));
  const memoryPath = join(root, "memory.json");
  const backing = new JsonFileMemoryAdapter(memoryPath);
  let failOnce = true;
  const flaky = new Proxy(backing, {
    get(target, property, receiver) {
      if (property === "putMemory") {
        return async (input) => {
          if (failOnce) {
            failOnce = false;
            const error = new Error("fictional temporary outage");
            error.code = "E_FAKE_UNAVAILABLE";
            throw error;
          }
          return target.putMemory(input);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const options = { dbPath: join(root, "runtime.db"), workspaceDir: join(root, "workspace"), memoryPolicy: fictionalMemoryPolicy(), memoryOperationMaxAttempts: 2 };
  const first = new HouseRuntime({ ...options, memoryAdapter: flaky }).registerAgent("agent:lantern", lanternAdapter);
  const run = await first.submit({ roomId: "room:fictional", agentId: "agent:lantern", message: "Resume this memory delivery.", idempotencyKey: "memory-restart" });
  assert.equal(run.result.memory_delivery_status, "pending");
  assert.deepEqual(first.listMemoryOperations().map((item) => item.status), ["pending", "pending"]);
  first.close();

  const reopenedAdapter = new JsonFileMemoryAdapter(memoryPath);
  const second = new HouseRuntime({ ...options, memoryAdapter: reopenedAdapter });
  const delivery = await second.drainMemoryOperations();
  assert.equal(delivery.some((item) => item.status === "delivered"), true);
  assert.equal(second.getRun(run.run_id).result.memory_delivery_status, "delivered");
  assert.equal((await second.listMemories("agent:lantern")).length, 1);
  assert.equal((await second.listResignatures("agent:lantern")).length, 1);
  second.close();
  backing.close();
  reopenedAdapter.close();
});

test("concurrent Runtime reflections rebase onto one Resignature chain", async () => {
  const root = mkdtempSync(join(tmpdir(), "house-runtime-memory-rebase-"));
  const memoryPath = join(root, "memory.json");
  const firstAdapter = new JsonFileMemoryAdapter(memoryPath);
  const secondAdapter = new JsonFileMemoryAdapter(memoryPath);
  const first = new HouseRuntime({ dbPath: join(root, "first.db"), workspaceDir: join(root, "first-workspace"), memoryAdapter: firstAdapter, memoryPolicy: fictionalMemoryPolicy() })
    .registerAgent("agent:lantern", lanternAdapter);
  const second = new HouseRuntime({ dbPath: join(root, "second.db"), workspaceDir: join(root, "second-workspace"), memoryAdapter: secondAdapter, memoryPolicy: fictionalMemoryPolicy() })
    .registerAgent("agent:lantern", lanternAdapter);
  const runs = await Promise.all([
    first.submit({ roomId: "room:first", agentId: "agent:lantern", message: "First concurrent reflection.", idempotencyKey: "concurrent-first" }),
    second.submit({ roomId: "room:second", agentId: "agent:lantern", message: "Second concurrent reflection.", idempotencyKey: "concurrent-second" }),
  ]);
  assert.equal(runs.every((run) => run.result.memory_delivery_status === "delivered"), true);
  const chain = await first.listResignatures("agent:lantern");
  assert.deepEqual(chain.map((item) => item.layer), [2, 1]);
  assert.equal(chain[0].previous_resignature_id, chain[1].resignature_id);
  first.close();
  second.close();
  firstAdapter.close();
  secondAdapter.close();
});

test("embedded memory migration plans first, copies idempotently, verifies, and never deletes source", async () => {
  const root = mkdtempSync(join(tmpdir(), "house-runtime-memory-migration-"));
  const options = { dbPath: join(root, "runtime.db"), workspaceDir: join(root, "workspace"), memoryPolicy: fictionalMemoryPolicy() };
  const runtime = new HouseRuntime(options).registerAgent("agent:lantern", lanternAdapter);
  await runtime.submit({ roomId: "room:fictional", agentId: "agent:lantern", message: "Create migration source one.", idempotencyKey: "migration-one" });
  await runtime.submit({ roomId: "room:fictional", agentId: "agent:lantern", message: "Create migration source two.", idempotencyKey: "migration-two" });
  const adapter = new SQLiteMemoryAdapter(join(root, "standalone-memory.db"));
  const plan = await migrateEmbeddedMemory({ store: runtime.store, adapter });
  assert.deepEqual(plan.source, { memories: 2, resignatures: 2, subjects: 1 });
  assert.equal(plan.executed, false);
  assert.equal((await adapter.queryMemories({ subjectId: "agent:lantern", limit: 20, includeQuarantined: true })).length, 0);
  const executed = await migrateEmbeddedMemory({ store: runtime.store, adapter, execute: true });
  assert.equal(executed.verified, true);
  assert.deepEqual(executed.copied, { memories: 2, resignatures: 2 });
  const repeated = await migrateEmbeddedMemory({ store: runtime.store, adapter, execute: true });
  assert.equal(repeated.verified, true);
  assert.equal(runtime.store.count("memories"), 2);
  assert.equal(runtime.store.count("resignatures"), 2);
  runtime.close();
  adapter.close();
});
