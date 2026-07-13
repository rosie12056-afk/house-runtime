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
    if (currentVersion > 4) throw new Error(`runtime database schema ${currentVersion} is newer than supported schema 4`);

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

      CREATE TABLE IF NOT EXISTS life_states (
        state_id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        schedule_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('awake', 'sleeping')),
        document_json TEXT NOT NULL,
        effective_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS life_states_subject_idx ON life_states(subject_id, effective_at DESC);

      CREATE TABLE IF NOT EXISTS lifecycle_opportunities (
        opportunity_id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        opportunity_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('offered', 'accepted', 'declined', 'expired')),
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        document_json TEXT NOT NULL,
        response_kind TEXT,
        response_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        next_attempt_at TEXT NOT NULL,
        retry_delay_minutes INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(subject_id, rule_id, window_start)
      );
      CREATE INDEX IF NOT EXISTS lifecycle_opportunities_open_idx ON lifecycle_opportunities(subject_id, status, window_end);

      CREATE TABLE IF NOT EXISTS lifecycle_records (
        record_id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        record_kind TEXT NOT NULL CHECK(record_kind IN ('journal', 'dream', 'handoff')),
        opportunity_id TEXT NOT NULL UNIQUE REFERENCES lifecycle_opportunities(opportunity_id),
        document_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS lifecycle_records_subject_idx ON lifecycle_records(subject_id, record_kind, created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_operations (
        operation_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        operation_kind TEXT NOT NULL CHECK(operation_kind IN ('put_memory', 'append_resignature')),
        status TEXT NOT NULL CHECK(status IN ('pending', 'delivered', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        document_json TEXT NOT NULL,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_operations_status_idx ON memory_operations(status, created_at);
      CREATE INDEX IF NOT EXISTS memory_operations_run_idx ON memory_operations(run_id, status, created_at);
    `);
    this.#ensureColumn("runs", "attempts", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("runs", "max_attempts", "INTEGER NOT NULL DEFAULT 3");
    this.#ensureColumn("lifecycle_opportunities", "attempts", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("lifecycle_opportunities", "max_attempts", "INTEGER NOT NULL DEFAULT 1");
    this.#ensureColumn("lifecycle_opportunities", "next_attempt_at", "TEXT NOT NULL DEFAULT ''");
    this.#ensureColumn("lifecycle_opportunities", "retry_delay_minutes", "INTEGER NOT NULL DEFAULT 15");
    this.db.prepare("UPDATE lifecycle_opportunities SET next_attempt_at = created_at WHERE next_attempt_at = ''").run();
    this.db.prepare("INSERT OR IGNORE INTO run_controls(run_id, timeout_ms, updated_at) SELECT run_id, 120000, updated_at FROM runs").run();
    this.db.prepare("UPDATE runtime_meta SET value = '4' WHERE key = 'schema_version'").run();
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

  listRuns({ status = null, limit = 50 } = {}) {
    const statuses = new Set(["queued", "running", "waiting_confirmation", "completed", "failed", "cancelled", "timed_out"]);
    if (status != null && !statuses.has(status)) throw Object.assign(new Error("unsupported Run status"), { code: "E_INVALID_PARAMS" });
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw Object.assign(new Error("limit must be an integer between 1 and 500"), { code: "E_INVALID_PARAMS" });
    const publicStatus = "COALESCE(c.terminal_status, CASE WHEN c.confirmation_id IS NOT NULL THEN 'waiting_confirmation' ELSE r.status END)";
    const rows = status == null
      ? this.db.prepare("SELECT r.* FROM runs r JOIN run_controls c ON c.run_id = r.run_id ORDER BY r.created_at DESC, r.run_id DESC LIMIT ?").all(limit)
      : this.db.prepare(`SELECT r.* FROM runs r JOIN run_controls c ON c.run_id = r.run_id WHERE ${publicStatus} = ? ORDER BY r.created_at DESC, r.run_id DESC LIMIT ?`).all(status, limit);
    return rows.map((row) => this.#mapRun(row));
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

  saveLifeState(document) {
    this.db.prepare("INSERT INTO life_states(state_id, subject_id, schedule_id, state, document_json, effective_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(document.state_id, document.subject_id, document.schedule_id, document.state, stringify(document), document.effective_at);
  }

  getLatestLifeState(subjectId) {
    const row = this.db.prepare("SELECT document_json FROM life_states WHERE subject_id = ? ORDER BY effective_at DESC, state_id DESC LIMIT 1").get(subjectId);
    return row ? parse(row.document_json) : null;
  }

  saveOpportunity(ruleId, document, { maxAttempts, retryDelayMinutes }) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("opportunity maxAttempts must be positive");
    if (!Number.isInteger(retryDelayMinutes) || retryDelayMinutes < 1) throw new Error("opportunity retryDelayMinutes must be positive");
    this.db.prepare("INSERT OR IGNORE INTO lifecycle_opportunities(opportunity_id, subject_id, rule_id, opportunity_type, status, window_start, window_end, document_json, attempts, max_attempts, next_attempt_at, retry_delay_minutes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)")
      .run(document.opportunity_id, document.subject_id, ruleId, document.opportunity_type, document.status, document.window_start, document.window_end, stringify(document), maxAttempts, document.created_at, retryDelayMinutes, document.created_at);
    const row = this.db.prepare("SELECT document_json FROM lifecycle_opportunities WHERE subject_id = ? AND rule_id = ? AND window_start = ?").get(document.subject_id, ruleId, document.window_start);
    return parse(row.document_json);
  }

  listOpenOpportunities(subjectId, at) {
    return this.db.prepare("SELECT document_json FROM lifecycle_opportunities WHERE subject_id = ? AND status = 'offered' AND attempts < max_attempts AND next_attempt_at <= ? AND window_start <= ? AND window_end > ? ORDER BY window_start, opportunity_id").all(subjectId, at, at, at)
      .map((row) => parse(row.document_json));
  }

  recordOpportunityFailure(opportunityId, at) {
    const row = this.db.prepare("SELECT attempts, max_attempts, retry_delay_minutes, document_json FROM lifecycle_opportunities WHERE opportunity_id = ? AND status = 'offered'").get(opportunityId);
    if (!row) return null;
    const attempts = row.attempts + 1;
    const exhausted = attempts >= row.max_attempts;
    const document = exhausted
      ? { ...parse(row.document_json), status: "declined", reason_codes: [...new Set([...parse(row.document_json).reason_codes, "attempt_budget_exhausted"])] }
      : parse(row.document_json);
    const nextAttemptAt = new Date(Date.parse(at) + row.retry_delay_minutes * 60000).toISOString();
    this.db.prepare("UPDATE lifecycle_opportunities SET attempts = ?, status = ?, next_attempt_at = ?, document_json = ? WHERE opportunity_id = ?")
      .run(attempts, document.status, nextAttemptAt, stringify(document), opportunityId);
    return document;
  }

  expireOpportunities(subjectId, at) {
    const rows = this.db.prepare("SELECT opportunity_id, document_json FROM lifecycle_opportunities WHERE subject_id = ? AND status = 'offered' AND window_end <= ?").all(subjectId, at);
    for (const row of rows) {
      const document = { ...parse(row.document_json), status: "expired" };
      this.db.prepare("UPDATE lifecycle_opportunities SET status = 'expired', document_json = ? WHERE opportunity_id = ?").run(stringify(document), row.opportunity_id);
    }
    return rows.length;
  }

  resolveOpportunity(opportunityId, document, responseKind = null, responseId = null) {
    this.db.prepare("UPDATE lifecycle_opportunities SET status = ?, document_json = ?, response_kind = ?, response_id = ? WHERE opportunity_id = ? AND status = 'offered'")
      .run(document.status, stringify(document), responseKind, responseId, opportunityId);
    return this.db.prepare("SELECT document_json FROM lifecycle_opportunities WHERE opportunity_id = ?").get(opportunityId)
      ? parse(this.db.prepare("SELECT document_json FROM lifecycle_opportunities WHERE opportunity_id = ?").get(opportunityId).document_json)
      : null;
  }

  saveLifecycleRecord(kind, opportunityId, document) {
    const idField = kind === "journal" ? "journal_id" : kind === "dream" ? "dream_id" : "handoff_id";
    this.db.prepare("INSERT INTO lifecycle_records(record_id, subject_id, record_kind, opportunity_id, document_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(document[idField], document.subject_id, kind, opportunityId, stringify(document), document.created_at);
  }

  listLifecycleRecords(subjectId, kind, limit = 20) {
    return this.db.prepare("SELECT document_json FROM lifecycle_records WHERE subject_id = ? AND record_kind = ? ORDER BY created_at DESC LIMIT ?").all(subjectId, kind, limit)
      .map((row) => parse(row.document_json));
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

  listEmbeddedMemoriesForMigration() {
    return this.db.prepare("SELECT * FROM memories ORDER BY subject_id, created_at, memory_id").all()
      .map((row) => ({
        run_id: row.run_id,
        memory: {
          memory_id: row.memory_id,
          subject_id: row.subject_id,
          kind: row.kind,
          body: row.body,
          source_refs: parse(row.source_refs_json),
          evidence_refs: parse(row.evidence_refs_json),
          status: row.status,
          created_at: row.created_at,
        },
      }));
  }

  listEmbeddedResignaturesForMigration() {
    return this.db.prepare("SELECT run_id, document_json FROM resignatures ORDER BY subject_id, layer, created_at, resignature_id").all()
      .map((row) => ({ run_id: row.run_id, resignature: parse(row.document_json) }));
  }

  enqueueMemoryOperation(document) {
    if (!Number.isInteger(document.max_attempts) || document.max_attempts < 1) throw new Error("memory operation max_attempts must be positive");
    this.db.prepare("INSERT OR IGNORE INTO memory_operations(operation_id, run_id, operation_kind, status, attempts, max_attempts, document_json, created_at, updated_at) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)")
      .run(document.operation_id, document.run_id, document.operation_kind, document.max_attempts, stringify(document), document.created_at, document.created_at);
    return this.getMemoryOperation(document.operation_id);
  }

  getMemoryOperation(operationId) {
    const row = this.db.prepare("SELECT * FROM memory_operations WHERE operation_id = ?").get(operationId);
    return row ? { ...row, document: parse(row.document_json) } : null;
  }

  listMemoryOperations({ runId = null, statuses = ["pending"] } = {}) {
    if (!Array.isArray(statuses) || statuses.length === 0 || statuses.some((status) => !new Set(["pending", "delivered", "failed"]).has(status))) throw new Error("invalid memory operation statuses");
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = runId
      ? this.db.prepare(`SELECT * FROM memory_operations WHERE run_id = ? AND status IN (${placeholders}) ORDER BY created_at, operation_id`).all(runId, ...statuses)
      : this.db.prepare(`SELECT * FROM memory_operations WHERE status IN (${placeholders}) ORDER BY created_at, operation_id`).all(...statuses);
    return rows.map((row) => ({ ...row, document: parse(row.document_json) }));
  }

  updateMemoryOperationDocument(operationId, document, at) {
    const changed = this.db.prepare("UPDATE memory_operations SET document_json = ?, updated_at = ? WHERE operation_id = ? AND status = 'pending'")
      .run(stringify(document), at, operationId).changes;
    if (changed !== 1) throw new Error(`pending memory operation not found: ${operationId}`);
    return this.getMemoryOperation(operationId);
  }

  markMemoryOperationDelivered(operationId, at) {
    this.db.prepare("UPDATE memory_operations SET status = 'delivered', attempts = attempts + 1, last_error_code = NULL, updated_at = ? WHERE operation_id = ? AND status = 'pending'")
      .run(at, operationId);
    return this.getMemoryOperation(operationId);
  }

  recordMemoryOperationFailure(operationId, errorCode, at) {
    const row = this.db.prepare("SELECT attempts, max_attempts FROM memory_operations WHERE operation_id = ? AND status = 'pending'").get(operationId);
    if (!row) return this.getMemoryOperation(operationId);
    const attempts = row.attempts + 1;
    const status = attempts >= row.max_attempts ? "failed" : "pending";
    this.db.prepare("UPDATE memory_operations SET status = ?, attempts = ?, last_error_code = ?, updated_at = ? WHERE operation_id = ?")
      .run(status, attempts, errorCode, at, operationId);
    return this.getMemoryOperation(operationId);
  }

  requeueFailedMemoryOperations(runId, at) {
    const result = runId
      ? this.db.prepare("UPDATE memory_operations SET status = 'pending', attempts = 0, last_error_code = NULL, updated_at = ? WHERE run_id = ? AND status = 'failed'").run(at, runId)
      : this.db.prepare("UPDATE memory_operations SET status = 'pending', attempts = 0, last_error_code = NULL, updated_at = ? WHERE status = 'failed'").run(at);
    return result.changes;
  }

  setRunMemoryDeliveryStatus(runId, status, at) {
    const row = this.db.prepare("SELECT result_json FROM runs WHERE run_id = ? AND status = 'completed'").get(runId);
    if (!row?.result_json) return null;
    const result = { ...parse(row.result_json), memory_delivery_status: status };
    this.db.prepare("UPDATE runs SET result_json = ?, updated_at = ? WHERE run_id = ?").run(stringify(result), at, runId);
    return result;
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
    const allowed = new Set(["artifacts", "audit_events", "confirmations", "context_manifests", "events", "evidence_bundles", "initiatives", "keels", "life_states", "lifecycle_opportunities", "lifecycle_records", "memories", "memory_operations", "outbox", "proposals", "resignatures", "runs", "scheduler_leases"]);
    if (!allowed.has(table)) throw new Error("unsupported count table");
    return this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  }

  close() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
  }
}
