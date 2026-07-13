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
    try {
      this.#migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO runtime_meta(key, value) VALUES ('schema_version', '1');
    `);
    const currentVersion = Number(this.db.prepare("SELECT value FROM runtime_meta WHERE key = 'schema_version'").get().value);
    if (!Number.isInteger(currentVersion) || currentVersion < 1) throw new Error("invalid runtime schema version");
    if (currentVersion > 2) throw new Error(`runtime database schema ${currentVersion} is newer than supported schema 2`);

    this.db.exec(`
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

      CREATE TABLE IF NOT EXISTS run_controls (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
        terminal_status TEXT CHECK(terminal_status IN ('cancelled', 'timed_out')),
        confirmation_id TEXT,
        timeout_ms INTEGER NOT NULL DEFAULT 120000,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS confirmations (
        confirmation_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
        grant_json TEXT NOT NULL,
        action_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'denied')),
        authenticated_by TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS scheduler_leases (
        lease_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        holder_id TEXT NOT NULL,
        fencing_token INTEGER NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('active', 'released', 'expired')),
        document_json TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        released_at TEXT
      );
      CREATE INDEX IF NOT EXISTS scheduler_leases_run_idx ON scheduler_leases(run_id, status, acquired_at);

      CREATE TABLE IF NOT EXISTS resignatures (
        resignature_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        subject_id TEXT NOT NULL,
        layer INTEGER NOT NULL,
        document_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS resignatures_subject_idx ON resignatures(subject_id, layer DESC, created_at DESC);

      CREATE TABLE IF NOT EXISTS audit_events (
        audit_id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES runs(run_id),
        event_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_events_run_idx ON audit_events(run_id, occurred_at);
    `);
    this.#ensureColumn("runs", "attempts", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("runs", "max_attempts", "INTEGER NOT NULL DEFAULT 3");
    this.db.prepare("INSERT OR IGNORE INTO run_controls(run_id, timeout_ms, updated_at) SELECT run_id, 120000, updated_at FROM runs").run();
    this.db.prepare("UPDATE runtime_meta SET value = '2' WHERE key = 'schema_version'").run();
  }

  #ensureColumn(table, column, definition) {
    const exists = this.db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
    if (!exists) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
    this.db.prepare("INSERT INTO runs(run_id, room_id, agent_id, request_event_id, status, attempts, max_attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)")
      .run(run.run_id, run.room_id, run.agent_id, run.request_event_id, run.max_attempts, run.created_at, run.created_at);
    this.db.prepare("INSERT INTO run_controls(run_id, timeout_ms, updated_at) VALUES (?, ?, ?)")
      .run(run.run_id, run.timeout_ms, run.created_at);
  }

  getRunByRequestEvent(eventId) {
    const row = this.db.prepare("SELECT * FROM runs WHERE request_event_id = ?").get(eventId);
    return this.#mapRun(row);
  }

  getRun(runId) {
    return this.#mapRun(this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId));
  }

  #mapRun(row) {
    if (!row) return null;
    const control = this.db.prepare("SELECT terminal_status, confirmation_id, timeout_ms FROM run_controls WHERE run_id = ?").get(row.run_id);
    const status = control?.terminal_status || (control?.confirmation_id ? "waiting_confirmation" : row.status);
    return {
      ...row,
      status,
      timeout_ms: control?.timeout_ms ?? 120000,
      confirmation_id: control?.confirmation_id || null,
      result: parse(row.result_json),
      error: parse(row.error_json),
    };
  }

  listPendingRuns() {
    return this.db.prepare("SELECT r.* FROM runs r JOIN run_controls c ON c.run_id = r.run_id WHERE r.status IN ('queued', 'running') AND c.terminal_status IS NULL AND c.confirmation_id IS NULL ORDER BY r.created_at").all().map((row) => this.#mapRun(row));
  }

  markRunRunning(runId, at) {
    return this.db.prepare("UPDATE runs SET status = 'running', attempts = attempts + 1, error_json = NULL, updated_at = ? WHERE run_id = ? AND status IN ('queued', 'running') AND attempts < max_attempts").run(at, runId).changes === 1;
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
    const result = this.db.prepare("UPDATE runs SET status = 'queued', error_json = NULL, updated_at = ? WHERE run_id = ? AND status = 'failed' AND attempts < max_attempts").run(at, runId);
    if (result.changes === 1) this.db.prepare("UPDATE run_controls SET terminal_status = NULL, updated_at = ? WHERE run_id = ?").run(at, runId);
    return result.changes === 1;
  }

  setTerminalStatus(runId, terminalStatus, error, at) {
    if (!new Set(["cancelled", "timed_out"]).has(terminalStatus)) throw new Error("unsupported terminal status");
    this.transaction(() => {
      this.db.prepare("UPDATE runs SET status = 'failed', error_json = ?, updated_at = ? WHERE run_id = ? AND status NOT IN ('completed')")
        .run(stringify(error), at, runId);
      this.db.prepare("UPDATE run_controls SET terminal_status = ?, confirmation_id = NULL, updated_at = ? WHERE run_id = ?")
        .run(terminalStatus, at, runId);
      this.db.prepare("UPDATE confirmations SET status = 'denied', resolved_at = ? WHERE run_id = ? AND status = 'pending'")
        .run(at, runId);
    });
  }

  createConfirmation(runId, confirmation, grant, at) {
    this.db.prepare("INSERT INTO confirmations(confirmation_id, run_id, grant_json, action_digest, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
      .run(confirmation.confirmation_id, runId, stringify(grant), confirmation.action_digest, at);
    this.db.prepare("UPDATE run_controls SET confirmation_id = ?, updated_at = ? WHERE run_id = ?")
      .run(confirmation.confirmation_id, at, runId);
  }

  getConfirmation(confirmationId) {
    const row = this.db.prepare("SELECT * FROM confirmations WHERE confirmation_id = ?").get(confirmationId);
    return row ? { ...row, grant: parse(row.grant_json) } : null;
  }

  resolveConfirmation(confirmationId, status, authenticatedBy, at) {
    if (!new Set(["approved", "denied"]).has(status)) throw new Error("unsupported confirmation status");
    const confirmation = this.getConfirmation(confirmationId);
    if (!confirmation || confirmation.status !== "pending") return null;
    this.transaction(() => {
      this.db.prepare("UPDATE confirmations SET status = ?, authenticated_by = ?, resolved_at = ? WHERE confirmation_id = ? AND status = 'pending'")
        .run(status, authenticatedBy, at, confirmationId);
      this.db.prepare("UPDATE run_controls SET confirmation_id = NULL, updated_at = ? WHERE run_id = ?")
        .run(at, confirmation.run_id);
      if (status === "denied") {
        this.db.prepare("UPDATE runs SET status = 'failed', error_json = ?, updated_at = ? WHERE run_id = ?")
          .run(stringify({ name: "ConfirmationDenied", message: "The authenticated user denied this operation." }), at, confirmation.run_id);
        this.db.prepare("UPDATE run_controls SET terminal_status = 'cancelled', updated_at = ? WHERE run_id = ?")
          .run(at, confirmation.run_id);
      }
    });
    return this.getConfirmation(confirmationId);
  }

  acquireLease(lease) {
    return this.transaction(() => {
      const expired = this.db.prepare("SELECT lease_id, document_json FROM scheduler_leases WHERE run_id = ? AND status = 'active' AND expires_at <= ?").all(lease.run_id, lease.acquired_at);
      for (const row of expired) {
        const document = { ...parse(row.document_json), status: "expired" };
        this.db.prepare("UPDATE scheduler_leases SET status = 'expired', document_json = ? WHERE lease_id = ?").run(stringify(document), row.lease_id);
      }
      const active = this.db.prepare("SELECT document_json FROM scheduler_leases WHERE run_id = ? AND status = 'active' AND expires_at > ? LIMIT 1").get(lease.run_id, lease.acquired_at);
      if (active) return null;
      const fencingToken = this.db.prepare("SELECT COALESCE(MAX(fencing_token), 0) + 1 AS token FROM scheduler_leases").get().token;
      const { run_id: runId, ...leaseDocument } = lease;
      const document = { ...leaseDocument, fencing_token: fencingToken };
      this.db.prepare("INSERT INTO scheduler_leases(lease_id, run_id, holder_id, fencing_token, status, document_json, acquired_at, expires_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)")
        .run(document.lease_id, runId, document.holder_id, fencingToken, stringify(document), document.acquired_at, document.expires_at);
      return document;
    });
  }

  releaseLease(leaseId, at) {
    const row = this.db.prepare("SELECT document_json FROM scheduler_leases WHERE lease_id = ? AND status = 'active'").get(leaseId);
    if (!row) return null;
    const document = { ...parse(row.document_json), status: "released", released_at: at };
    this.db.prepare("UPDATE scheduler_leases SET status = 'released', released_at = ?, document_json = ? WHERE lease_id = ? AND status = 'active'")
      .run(at, stringify(document), leaseId);
    return document;
  }

  getActiveLease(runId) {
    const row = this.db.prepare("SELECT document_json FROM scheduler_leases WHERE run_id = ? AND status = 'active' ORDER BY fencing_token DESC LIMIT 1").get(runId);
    return row ? parse(row.document_json) : null;
  }

  saveAudit(event) {
    this.db.prepare("INSERT INTO audit_events(audit_id, run_id, event_type, actor_id, detail_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(event.audit_id, event.run_id || null, event.event_type, event.actor_id, stringify(event.detail || {}), event.occurred_at);
  }

  listAudit(runId) {
    return this.db.prepare("SELECT * FROM audit_events WHERE run_id = ? ORDER BY occurred_at, audit_id").all(runId)
      .map((row) => ({ ...row, detail: parse(row.detail_json) }));
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

  saveResignature(runId, resignature) {
    this.db.prepare("INSERT INTO resignatures(resignature_id, run_id, subject_id, layer, document_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(resignature.resignature_id, runId, resignature.subject_id, resignature.layer, stringify(resignature), resignature.created_at);
  }

  getLatestResignature(subjectId) {
    const row = this.db.prepare("SELECT document_json FROM resignatures WHERE subject_id = ? ORDER BY layer DESC, created_at DESC LIMIT 1").get(subjectId);
    return row ? parse(row.document_json) : null;
  }

  listResignatures(subjectId, limit = 20) {
    return this.db.prepare("SELECT document_json FROM resignatures WHERE subject_id = ? ORDER BY layer DESC, created_at DESC LIMIT ?").all(subjectId, limit)
      .map((row) => parse(row.document_json));
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
    const allowed = new Set(["artifacts", "audit_events", "confirmations", "context_manifests", "events", "evidence_bundles", "initiatives", "keels", "memories", "outbox", "proposals", "resignatures", "runs", "scheduler_leases"]);
    if (!allowed.has(table)) throw new Error("unsupported count table");
    return this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  }

  close() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
  }
}
