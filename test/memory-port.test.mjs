import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runMemoryPortConformance } from "house-toolkit/src/conformance.mjs";
import { assertMemoryPortCandidate, JsonFileMemoryAdapter, SQLiteMemoryAdapter } from "../src/index.mjs";

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
