import { assertMemoryPortCandidate } from "./memory-port-candidate.mjs";

function subjectsOf(memories, resignatures) {
  return [...new Set([
    ...memories.map((item) => item.memory.subject_id),
    ...resignatures.map((item) => item.resignature.subject_id),
  ])].sort();
}

export async function migrateEmbeddedMemory({ store, adapter, execute = false } = {}) {
  if (!store || typeof store.listEmbeddedMemoriesForMigration !== "function" || typeof store.listEmbeddedResignaturesForMigration !== "function") throw new Error("RuntimeStore migration source is required");
  assertMemoryPortCandidate(adapter);
  const health = await adapter.health();
  if (health?.ok !== true) throw Object.assign(new Error("target Memory Adapter is not healthy"), { code: "E_MEMORY_MIGRATION_TARGET_UNHEALTHY" });
  const memories = store.listEmbeddedMemoriesForMigration();
  const resignatures = store.listEmbeddedResignaturesForMigration();
  const subjects = subjectsOf(memories, resignatures);
  const plan = {
    mode: execute ? "execute" : "plan",
    source: { memories: memories.length, resignatures: resignatures.length, subjects: subjects.length },
    target_adapter: health.adapter || "custom",
    source_deleted: false,
  };
  if (!execute) return { ...plan, ok: true, executed: false, verified: false };

  let memoriesCopied = 0;
  let resignaturesCopied = 0;
  for (const item of memories) {
    await adapter.putMemory({
      operationId: `migration-operation:${item.memory.memory_id}`,
      runId: item.run_id,
      memory: structuredClone(item.memory),
    });
    memoriesCopied += 1;
  }
  for (const item of resignatures) {
    await adapter.appendResignature({
      operationId: `migration-operation:${item.resignature.resignature_id}`,
      runId: item.run_id,
      expectedPreviousId: item.resignature.previous_resignature_id || null,
      resignature: structuredClone(item.resignature),
    });
    resignaturesCopied += 1;
  }

  let verifiedMemories = 0;
  let verifiedResignatures = 0;
  for (const subjectId of subjects) {
    verifiedMemories += (await adapter.queryMemories({ subjectId, limit: 1000, includeQuarantined: true })).length;
    verifiedResignatures += (await adapter.queryResignatures({ subjectId, limit: 1000 })).length;
  }
  const verified = verifiedMemories >= memories.length && verifiedResignatures >= resignatures.length;
  if (!verified) throw Object.assign(new Error("target verification counts are lower than the migration source"), { code: "E_MEMORY_MIGRATION_VERIFY" });
  return {
    ...plan,
    ok: true,
    executed: true,
    copied: { memories: memoriesCopied, resignatures: resignaturesCopied },
    verified: true,
    target: { memories: verifiedMemories, resignatures: verifiedResignatures },
  };
}
