# Runtime Alpha.1 to Alpha.2 Migration

Alpha.2 performs a forward-only SQLite schema upgrade from version 1 to version 2.

## Added state

- `runs.attempts` and `runs.max_attempts`;
- `run_controls` for timeout, confirmation, cancellation, and timeout status;
- `confirmations`, `scheduler_leases`, `resignatures`, and `audit_events`.

The existing `runs` table is not rebuilt. Existing Runs receive a default control record, three maximum attempts, and a 120-second adapter-generation timeout. Existing Events and other protocol records are not rewritten. Stored `0.1` records remain readable; new alpha.2 records use Protocols `0.2`.

## Before upgrade

1. Stop every process that can open the Runtime database.
2. Copy the database, its `-wal` file, its `-shm` file, and the workspace directory together.
3. Start one alpha.2 process and run the restart smoke tests before allowing other workers.

## Rollback

Alpha.1 can still read its original tables because alpha.2 does not rebuild or remove them. It ignores the new tables and columns. Rollback means stopping alpha.2, restoring the coordinated backup, and restarting alpha.1. Do not run alpha.1 and alpha.2 against the same database concurrently.

Databases declaring a schema newer than version 2 are rejected. The Runtime never silently downgrades a future database.
