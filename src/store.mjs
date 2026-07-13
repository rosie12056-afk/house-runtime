import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function parse(value) {
  return value == null ? null : JSON.parse(value);
}

function stringify(value) {
  return JSON.stringify(value);
}

export class RuntimeStore {
  constructor(path) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.path);
    chmodSync(this.path, 0o600);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.#migrate();
    this.db.prepare("UPDATE runs SET status = 'queued', updated_at = ? WHERE status = 'running'").run(new Date().toISOString());
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO runtime_meta(key, value) VALUES ('schema_version', '1');

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        room_id TEXT NOT NULL,
        document_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        request_event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed')),
        result_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status, created_at);

      CREATE TABLE IF NOT EXISTS proposals (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
        proposal_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS context_manifests (
        manifest_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
        document_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS keels (
        keel_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        subject_id TEXT NOT NULL,
        document_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(keel_id, revision)
      );
      CREATE INDEX IF NOT EXISTS keels_subject_idx ON keels(subject_id, revision DESC);

      CREATE TABLE IF NOT EXISTS initiatives (
        initiative_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
        status TEXT NOT NULL,
        document_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evidence_bundles (
        bundle_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
        document_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        locator TEXT NOT NULL UNIQUE,
        digest TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_policy_decisions (
        decision_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        document_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        memory_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        subject_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'quarantined')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memories_subject_idx ON memories(subject_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS outbox (
        outbox_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
        status TEXT NOT NULL CHECK(status IN ('pending', 'delivered', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_status_idx ON outbox(status, created_at);
    `);
  }

  transaction(operation) {
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

  insertEvent(event, roomId) {
    this.db.prepare("INSERT INTO events(event_id, idempotency_key, room_id, document_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(event.event_id, event.idempotency_key, roomId, stringify(event), event.occurred_at);
  }

  findEventByIdempotency(key) {
    const row = this.db.prepare("SELECT document_json FROM events WHERE idempotency_key = ?").get(key);
    return row ? parse(row.document_json) : null;
  }

  getEvent(eventId) {
    const row = this.db.prepare("SELECT document_json FROM events WHERE event_id = ?").get(eventId);
    return row ? parse(row.document_json) : null;
  }

  createRun(run) {
    this.db.prepare("INSERT INTO runs(run_id, room_id, agent_id, request_event_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)")
      .run(run.run_id, run.room_id, run.agent_id, run.request_event_id, run.created_at, run.created_at);
  }

  getRunByRequestEvent(eventId) {
    const row = this.db.prepare("SELECT * FROM runs WHERE request_event_id = ?").get(eventId);
    return this.#mapRun(row);
  }

  getRun(runId) {
    return this.#mapRun(this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId));
  }

  #mapRun(row) {
    return row ? { ...row, result: parse(row.result_json), error: parse(row.error_json) } : null;
  }

  listPendingRuns() {
    return this.db.prepare("SELECT * FROM runs WHERE status IN ('queued', 'running') ORDER BY created_at").all().map((row) => this.#mapRun(row));
  }

  markRunRunning(runId, at) {
    this.db.prepare("UPDATE runs SET status = 'running', error_json = NULL, updated_at = ? WHERE run_id = ?").run(at, runId);
  }

  completeRun(runId, result, at) {
    this.db.prepare("UPDATE runs SET status = 'completed', result_json = ?, error_json = NULL, updated_at = ? WHERE run_id = ?")
      .run(stringify(result), at, runId);
  }

  failRun(runId, error, at) {
    this.db.prepare("UPDATE runs SET status = 'failed', error_json = ?, updated_at = ? WHERE run_id = ?")
      .run(stringify(error), at, runId);
  }

  requeueRun(runId, at) {
    const result = this.db.prepare("UPDATE runs SET status = 'queued', error_json = NULL, updated_at = ? WHERE run_id = ? AND status = 'failed'").run(at, runId);
    return result.changes === 1;
  }

  saveProposal(runId, proposal, at) {
    this.db.prepare("INSERT OR IGNORE INTO proposals(run_id, proposal_json, created_at) VALUES (?, ?, ?)")
      .run(runId, stringify(proposal), at);
  }

  getProposal(runId) {
    const row = this.db.prepare("SELECT proposal_json FROM proposals WHERE run_id = ?").get(runId);
    return row ? parse(row.proposal_json) : null;
  }

  saveManifest(runId, manifest) {
    this.db.prepare("INSERT INTO context_manifests(manifest_id, run_id, document_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET document_json = excluded.document_json")
      .run(manifest.manifest_id, runId, stringify(manifest), manifest.created_at);
  }

  getManifest(runId) {
    const row = this.db.prepare("SELECT document_json FROM context_manifests WHERE run_id = ?").get(runId);
    return row ? parse(row.document_json) : null;
  }

  insertKeel(keel) {
    this.db.prepare("INSERT INTO keels(keel_id, revision, subject_id, document_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(keel.keel_id, keel.revision, keel.subject_id, stringify(keel), keel.created_at);
  }

  getCurrentKeel(subjectId) {
    const row = this.db.prepare("SELECT document_json FROM keels WHERE subject_id = ? ORDER BY revision DESC LIMIT 1").get(subjectId);
    return row ? parse(row.document_json) : null;
  }

  saveInitiative(runId, initiative) {
    this.db.prepare("INSERT INTO initiatives(initiative_id, run_id, status, document_json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(initiative_id) DO UPDATE SET status = excluded.status, document_json = excluded.document_json, updated_at = excluded.updated_at")
      .run(initiative.initiative_id, runId, initiative.status, stringify(initiative), initiative.updated_at);
  }

  getInitiative(runId) {
    const row = this.db.prepare("SELECT document_json FROM initiatives WHERE run_id = ?").get(runId);
    return row ? parse(row.document_json) : null;
  }

  saveEvidence(runId, evidence) {
    this.db.prepare("INSERT OR REPLACE INTO evidence_bundles(bundle_id, run_id, document_json, created_at) VALUES (?, ?, ?, ?)")
      .run(evidence.bundle_id, runId, stringify(evidence), evidence.created_at);
  }

  getEvidence(runId) {
    const row = this.db.prepare("SELECT document_json FROM evidence_bundles WHERE run_id = ?").get(runId);
    return row ? parse(row.document_json) : null;
  }

  saveArtifact(runId, artifact, at) {
    this.db.prepare("INSERT INTO artifacts(artifact_id, run_id, locator, digest, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(artifact_id) DO UPDATE SET locator = excluded.locator, digest = excluded.digest, size_bytes = excluded.size_bytes")
      .run(artifact.artifact_id, runId, artifact.locator, artifact.digest, artifact.size_bytes, at);
  }

  getArtifact(artifactId) {
    return this.db.prepare("SELECT * FROM artifacts WHERE artifact_id = ?").get(artifactId) || null;
  }

  saveMemoryPolicy(runId, decision) {
    this.db.prepare("INSERT OR REPLACE INTO memory_policy_decisions(decision_id, run_id, document_json, created_at) VALUES (?, ?, ?, ?)")
      .run(decision.decision_id, runId, stringify(decision), decision.decided_at);
  }

  saveMemory(runId, memory) {
    this.db.prepare("INSERT OR REPLACE INTO memories(memory_id, run_id, subject_id, kind, body, source_refs_json, evidence_refs_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(memory.memory_id, runId, memory.subject_id, memory.kind, memory.body, stringify(memory.source_refs), stringify(memory.evidence_refs), memory.status, memory.created_at);
  }

  listMemories(subjectId, limit = 20, { includeQuarantined = false } = {}) {
    const rows = includeQuarantined
      ? this.db.prepare("SELECT * FROM memories WHERE subject_id = ? ORDER BY created_at DESC LIMIT ?").all(subjectId, limit)
      : this.db.prepare("SELECT * FROM memories WHERE subject_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT ?").all(subjectId, limit);
    return rows.map((row) => ({ ...row, source_refs: parse(row.source_refs_json), evidence_refs: parse(row.evidence_refs_json) }));
  }

  enqueueOutbox(runId, outboxId, eventId, at) {
    this.db.prepare("INSERT OR IGNORE INTO outbox(outbox_id, run_id, event_id, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)")
      .run(outboxId, runId, eventId, at, at);
  }

  listOutbox(status = "pending") {
    return this.db.prepare("SELECT * FROM outbox WHERE status = ? ORDER BY created_at").all(status);
  }

  markOutbox(outboxId, status, at, error = null) {
    this.db.prepare("UPDATE outbox SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ? WHERE outbox_id = ?")
      .run(status, error, at, outboxId);
  }

  count(table) {
    const allowed = new Set(["artifacts", "context_manifests", "events", "evidence_bundles", "initiatives", "keels", "memories", "outbox", "proposals", "runs"]);
    if (!allowed.has(table)) throw new Error("unsupported count table");
    return this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  }

  close() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
  }
}
