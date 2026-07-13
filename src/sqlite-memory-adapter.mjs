import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  normalizeMemoryQuery,
  normalizeResignatureQuery,
  operationDigest,
  portConflict,
  validateMemoryWrite,
  validateResignatureAppend,
} from "./memory-port-candidate.mjs";

function parse(value) {
  return value == null ? null : JSON.parse(value);
}

export class SQLiteMemoryAdapter {
  constructor(path) {
    if (typeof path !== "string" || path.length === 0) throw new Error("SQLite memory path is required");
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.path);
    chmodSync(this.path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS adapter_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO adapter_meta(key, value) VALUES ('schema_version', '1');
      CREATE TABLE IF NOT EXISTS memories (
        memory_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'quarantined')),
        created_at TEXT NOT NULL,
        document_json TEXT NOT NULL,
        document_digest TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memories_subject_idx ON memories(subject_id, created_at DESC, memory_id DESC);
      CREATE TABLE IF NOT EXISTS resignatures (
        resignature_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        layer INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        document_json TEXT NOT NULL,
        document_digest TEXT NOT NULL,
        UNIQUE(subject_id, layer)
      );
      CREATE INDEX IF NOT EXISTS resignatures_subject_idx ON resignatures(subject_id, layer DESC, created_at DESC);
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        operation_kind TEXT NOT NULL CHECK(operation_kind IN ('put_memory', 'append_resignature')),
        run_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const version = this.db.prepare("SELECT value FROM adapter_meta WHERE key = 'schema_version'").get()?.value;
    if (version !== "1") {
      this.db.close();
      throw new Error(`unsupported SQLite memory schema: ${version}`);
    }
  }

  async health() {
    return { ok: this.db.prepare("PRAGMA quick_check").get().quick_check === "ok", adapter: "sqlite", schema_version: "1" };
  }

  async queryMemories(options) {
    const { subjectId, limit, includeQuarantined } = normalizeMemoryQuery(options);
    const rows = includeQuarantined
      ? this.db.prepare("SELECT document_json FROM memories WHERE subject_id = ? ORDER BY created_at DESC, memory_id DESC LIMIT ?").all(subjectId, limit)
      : this.db.prepare("SELECT document_json FROM memories WHERE subject_id = ? AND status = 'active' ORDER BY created_at DESC, memory_id DESC LIMIT ?").all(subjectId, limit);
    return rows.map((row) => parse(row.document_json));
  }

  async putMemory(input) {
    const { operationId, runId, memory } = validateMemoryWrite(input);
    const document = JSON.stringify(memory);
    const digest = operationDigest({ runId, memory });
    return this.#transaction(() => {
      const previousOperation = this.db.prepare("SELECT * FROM operations WHERE operation_id = ?").get(operationId);
      if (previousOperation) {
        if (previousOperation.operation_kind !== "put_memory" || previousOperation.payload_digest !== digest) throw portConflict("E_MEMORY_OPERATION_CONFLICT", "operationId was reused with a different memory write");
        return parse(this.db.prepare("SELECT document_json FROM memories WHERE memory_id = ?").get(previousOperation.resource_id)?.document_json);
      }
      const previousRecord = this.db.prepare("SELECT document_digest FROM memories WHERE memory_id = ?").get(memory.memory_id);
      const documentDigest = operationDigest(memory);
      if (previousRecord && previousRecord.document_digest !== documentDigest) throw portConflict("E_MEMORY_RESOURCE_CONFLICT", "memory_id already stores different content");
      this.db.prepare("INSERT OR IGNORE INTO memories(memory_id, run_id, subject_id, status, created_at, document_json, document_digest) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(memory.memory_id, runId, memory.subject_id, memory.status, memory.created_at, document, documentDigest);
      this.db.prepare("INSERT INTO operations(operation_id, operation_kind, run_id, resource_id, payload_digest, created_at) VALUES (?, 'put_memory', ?, ?, ?, ?)")
        .run(operationId, runId, memory.memory_id, digest, memory.created_at);
      return structuredClone(memory);
    });
  }

  async latestResignature(options) {
    const { subjectId } = normalizeResignatureQuery({ ...options, limit: 1 });
    const row = this.db.prepare("SELECT document_json FROM resignatures WHERE subject_id = ? ORDER BY layer DESC, created_at DESC LIMIT 1").get(subjectId);
    return row ? parse(row.document_json) : null;
  }

  async queryResignatures(options) {
    const { subjectId, limit } = normalizeResignatureQuery(options);
    return this.db.prepare("SELECT document_json FROM resignatures WHERE subject_id = ? ORDER BY layer DESC, created_at DESC LIMIT ?").all(subjectId, limit)
      .map((row) => parse(row.document_json));
  }

  async appendResignature(input) {
    const { operationId, runId, expectedPreviousId, resignature } = validateResignatureAppend(input);
    const document = JSON.stringify(resignature);
    const digest = operationDigest({ runId, expectedPreviousId, resignature });
    return this.#transaction(() => {
      const previousOperation = this.db.prepare("SELECT * FROM operations WHERE operation_id = ?").get(operationId);
      if (previousOperation) {
        if (previousOperation.operation_kind !== "append_resignature" || previousOperation.payload_digest !== digest) throw portConflict("E_MEMORY_OPERATION_CONFLICT", "operationId was reused with a different Resignature append");
        return parse(this.db.prepare("SELECT document_json FROM resignatures WHERE resignature_id = ?").get(previousOperation.resource_id)?.document_json);
      }
      const head = this.db.prepare("SELECT resignature_id, layer FROM resignatures WHERE subject_id = ? ORDER BY layer DESC, created_at DESC LIMIT 1").get(resignature.subject_id) || null;
      if ((head?.resignature_id || null) !== expectedPreviousId || resignature.layer !== (head?.layer || 0) + 1) throw portConflict("E_RESIGNATURE_CONFLICT", "Resignature head changed before append");
      this.db.prepare("INSERT INTO resignatures(resignature_id, run_id, subject_id, layer, created_at, document_json, document_digest) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(resignature.resignature_id, runId, resignature.subject_id, resignature.layer, resignature.created_at, document, operationDigest(resignature));
      this.db.prepare("INSERT INTO operations(operation_id, operation_kind, run_id, resource_id, payload_digest, created_at) VALUES (?, 'append_resignature', ?, ?, ?, ?)")
        .run(operationId, runId, resignature.resignature_id, digest, resignature.created_at);
      return structuredClone(resignature);
    });
  }

  #transaction(operation) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
  }
}
