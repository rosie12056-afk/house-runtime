import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  normalizeMemoryQuery,
  normalizeResignatureQuery,
  operationDigest,
  portConflict,
  validateMemoryWrite,
  validateResignatureAppend,
} from "./memory-port-candidate.mjs";

const EMPTY_STATE = Object.freeze({ schema_version: "1", memories: [], resignatures: [], operations: [] });

function pause(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export class JsonFileMemoryAdapter {
  constructor(path, { lockTimeoutMs = 5000 } = {}) {
    if (typeof path !== "string" || path.length === 0) throw new Error("JSON memory path is required");
    this.path = resolve(path);
    this.lockPath = `${this.path}.lock`;
    this.lockTimeoutMs = lockTimeoutMs;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (!existsSync(this.path)) {
      try {
        writeFileSync(this.path, `${JSON.stringify(EMPTY_STATE, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    chmodSync(this.path, 0o600);
    this.#read();
  }

  async health() {
    const state = this.#read();
    return { ok: state.schema_version === "1", adapter: "json-file", schema_version: state.schema_version };
  }

  async queryMemories(options) {
    const { subjectId, limit, includeQuarantined } = normalizeMemoryQuery(options);
    return this.#read().memories
      .filter((item) => item.document.subject_id === subjectId && (includeQuarantined || item.document.status === "active"))
      .sort((a, b) => b.document.created_at.localeCompare(a.document.created_at) || b.document.memory_id.localeCompare(a.document.memory_id))
      .slice(0, limit)
      .map((item) => structuredClone(item.document));
  }

  async putMemory(input) {
    const { operationId, runId, memory } = validateMemoryWrite(input);
    const digest = operationDigest({ runId, memory });
    return this.#withLock((state) => {
      const previousOperation = state.operations.find((item) => item.operation_id === operationId);
      if (previousOperation) {
        if (previousOperation.operation_kind !== "put_memory" || previousOperation.payload_digest !== digest) throw portConflict("E_MEMORY_OPERATION_CONFLICT", "operationId was reused with a different memory write");
        return { result: structuredClone(state.memories.find((item) => item.document.memory_id === previousOperation.resource_id)?.document), changed: false };
      }
      const previousRecord = state.memories.find((item) => item.document.memory_id === memory.memory_id);
      const documentDigest = operationDigest(memory);
      if (previousRecord && previousRecord.document_digest !== documentDigest) throw portConflict("E_MEMORY_RESOURCE_CONFLICT", "memory_id already stores different content");
      if (!previousRecord) state.memories.push({ run_id: runId, document_digest: documentDigest, document: structuredClone(memory) });
      state.operations.push({ operation_id: operationId, operation_kind: "put_memory", run_id: runId, resource_id: memory.memory_id, payload_digest: digest, created_at: memory.created_at });
      return { result: structuredClone(memory), changed: true };
    });
  }

  async latestResignature(options) {
    const records = await this.queryResignatures({ ...options, limit: 1 });
    return records[0] || null;
  }

  async queryResignatures(options) {
    const { subjectId, limit } = normalizeResignatureQuery(options);
    return this.#read().resignatures
      .filter((item) => item.document.subject_id === subjectId)
      .sort((a, b) => b.document.layer - a.document.layer || b.document.created_at.localeCompare(a.document.created_at))
      .slice(0, limit)
      .map((item) => structuredClone(item.document));
  }

  async appendResignature(input) {
    const { operationId, runId, expectedPreviousId, resignature } = validateResignatureAppend(input);
    const digest = operationDigest({ runId, expectedPreviousId, resignature });
    return this.#withLock((state) => {
      const previousOperation = state.operations.find((item) => item.operation_id === operationId);
      if (previousOperation) {
        if (previousOperation.operation_kind !== "append_resignature" || previousOperation.payload_digest !== digest) throw portConflict("E_MEMORY_OPERATION_CONFLICT", "operationId was reused with a different Resignature append");
        return { result: structuredClone(state.resignatures.find((item) => item.document.resignature_id === previousOperation.resource_id)?.document), changed: false };
      }
      const head = state.resignatures
        .filter((item) => item.document.subject_id === resignature.subject_id)
        .sort((a, b) => b.document.layer - a.document.layer || b.document.created_at.localeCompare(a.document.created_at))[0]?.document || null;
      if ((head?.resignature_id || null) !== expectedPreviousId || resignature.layer !== (head?.layer || 0) + 1) throw portConflict("E_RESIGNATURE_CONFLICT", "Resignature head changed before append");
      state.resignatures.push({ run_id: runId, document_digest: operationDigest(resignature), document: structuredClone(resignature) });
      state.operations.push({ operation_id: operationId, operation_kind: "append_resignature", run_id: runId, resource_id: resignature.resignature_id, payload_digest: digest, created_at: resignature.created_at });
      return { result: structuredClone(resignature), changed: true };
    });
  }

  #read() {
    const state = JSON.parse(readFileSync(this.path, "utf8"));
    if (state?.schema_version !== "1" || !Array.isArray(state.memories) || !Array.isArray(state.resignatures) || !Array.isArray(state.operations)) {
      throw new Error("unsupported or malformed JSON memory state");
    }
    return state;
  }

  async #withLock(operation) {
    const started = Date.now();
    while (true) {
      try {
        mkdirSync(this.lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (Date.now() - started >= this.lockTimeoutMs) throw portConflict("E_MEMORY_ADAPTER_BUSY", "timed out waiting for JSON memory lock");
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > this.lockTimeoutMs * 4) throw portConflict("E_MEMORY_ADAPTER_STALE_LOCK", "JSON memory lock is stale and requires operator review");
        } catch (statError) {
          if (statError.code !== "ENOENT") throw statError;
        }
        await pause(10);
      }
    }
    try {
      const state = this.#read();
      const { result, changed } = operation(state);
      if (changed) this.#write(state);
      return result;
    } finally {
      rmSync(this.lockPath, { recursive: true, force: true });
    }
  }

  #write(state) {
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }

  close() {}
}
