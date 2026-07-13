import { createHash } from "node:crypto";

export const MEMORY_PORT_CANDIDATE_METHODS = Object.freeze([
  "health",
  "queryMemories",
  "putMemory",
  "latestResignature",
  "queryResignatures",
  "appendResignature",
]);

export function assertMemoryPortCandidate(port) {
  for (const method of MEMORY_PORT_CANDIDATE_METHODS) {
    if (!port || typeof port[method] !== "function") throw new Error(`Memory Port candidate must implement ${method}()`);
  }
  return port;
}

export function normalizeMemoryQuery({ subjectId, limit = 20, includeQuarantined = false } = {}) {
  if (typeof subjectId !== "string" || subjectId.length === 0) throw new Error("subjectId is required");
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit must be an integer from 1 to 1000");
  if (typeof includeQuarantined !== "boolean") throw new Error("includeQuarantined must be boolean");
  return { subjectId, limit, includeQuarantined };
}

export function normalizeResignatureQuery({ subjectId, limit = 20 } = {}) {
  const query = normalizeMemoryQuery({ subjectId, limit, includeQuarantined: false });
  return { subjectId: query.subjectId, limit: query.limit };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function operationDigest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function portConflict(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function validateMemoryWrite({ operationId, runId, memory } = {}) {
  if (typeof operationId !== "string" || operationId.length === 0) throw new Error("operationId is required");
  if (typeof runId !== "string" || runId.length === 0) throw new Error("runId is required");
  if (!memory || typeof memory !== "object") throw new Error("memory is required");
  for (const field of ["memory_id", "subject_id", "kind", "body", "status", "created_at"]) {
    if (typeof memory[field] !== "string" || memory[field].length === 0) throw new Error(`memory.${field} is required`);
  }
  if (!new Set(["active", "quarantined"]).has(memory.status)) throw new Error("memory.status is invalid");
  if (!Array.isArray(memory.source_refs) || !Array.isArray(memory.evidence_refs)) throw new Error("memory references must be arrays");
  return { operationId, runId, memory: structuredClone(memory) };
}

export function validateResignatureAppend({ operationId, runId, expectedPreviousId = null, resignature } = {}) {
  if (typeof operationId !== "string" || operationId.length === 0) throw new Error("operationId is required");
  if (typeof runId !== "string" || runId.length === 0) throw new Error("runId is required");
  if (expectedPreviousId !== null && (typeof expectedPreviousId !== "string" || expectedPreviousId.length === 0)) throw new Error("expectedPreviousId must be null or a non-empty string");
  if (!resignature || typeof resignature !== "object") throw new Error("resignature is required");
  for (const field of ["resignature_id", "subject_id", "created_at"]) {
    if (typeof resignature[field] !== "string" || resignature[field].length === 0) throw new Error(`resignature.${field} is required`);
  }
  if (!Number.isInteger(resignature.layer) || resignature.layer < 1) throw new Error("resignature.layer must be a positive integer");
  if ((resignature.previous_resignature_id || null) !== expectedPreviousId) throw portConflict("E_RESIGNATURE_CONFLICT", "document previous_resignature_id does not match expectedPreviousId");
  return { operationId, runId, expectedPreviousId, resignature: structuredClone(resignature) };
}
