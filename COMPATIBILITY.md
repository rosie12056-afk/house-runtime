# Compatibility

## Released lifecycle baseline

The released alpha line remains pinned to stable v0.2. Runtime `v0.2.0` explicitly adopts stable lifecycle contracts and committed lockfile SHAs:

| Dependency | Locked release | Role | Loaded at runtime |
| --- | --- | --- | --- |
| House Protocols | `v0.2.1` | Stable v0.2 plus additive lifecycle contracts | Yes |
| House Toolkit | `v0.2.1` | Migration, privacy, lifecycle, and conformance checks | No; development dependency only |

The Runtime requires Node.js 22.13 or newer and is tested on Node 22 and 24.

## Upgrade behavior

- Publishing House Protocols v0.2 cannot change Runtime `v0.1.0-alpha.1`; the dependency does not use a floating range.
- Runtime alpha.1 rejects documents whose declared protocol version is not supported by its locked validators.
- Runtime adopts Protocols v0.2 only in a new Runtime release after migration fixtures and Toolkit conformance pass.
- A newer Toolkit may audit an older Runtime, but changing a release gate requires a Runtime commit and CI result. The Toolkit is not silently downloaded or executed by a running Runtime.
- Database schema migrations must be forward-only, versioned, restart-tested, and documented before a Runtime release changes its storage schema.

## Compatibility history

| Runtime | Protocol document profile | Toolkit profile | Status |
| --- | --- | --- | --- |
| `v0.1.0-alpha.1` | `0.1` | Toolkit `v0.1.1` | Tested and released |
| `v0.1.0-alpha.2.1` | writes `0.2` and retains stored `0.1` reads | Toolkit `v0.2.0` | Tested; shared migrations, restart confirmation, lease expiry, cancellation, timeout, and retry boundaries pass |
| `v0.2.0` | `0.2` plus additive lifecycle records | Toolkit `v0.2.1` | Released; fake-clock sleep, restart, tick, journal, dream, handoff, delivery, and feedback tests pass |
| `v0.3.0-rc.1` | `0.2` records plus Runtime API envelopes from Protocols `v0.3.0-rc.1` | Toolkit `v0.3.0-rc.1` | Release candidate; two adapters, two clients, restart delivery, concurrent Resignature rebase, and explicit migration pass |
| `v0.3.0-rc.2` | `0.2` records plus read-only Runtime API methods from Protocols `v0.3.0-rc.2` | Toolkit `v0.3.0-rc.3` | Release candidate; Run listing and Evidence/Initiative readback pass two-client conformance |

Compatibility is established by fixtures and restart tests, not by similar version labels.

## September 2026 maintenance

Package `0.3.0-rc.3` follows `0.3.0-rc.2` with unchanged document profiles and storage semantics. Its exact dependency tags are `house-protocols#v0.3.0-rc.3`, `house-toolkit#v0.3.0-rc.4`. Use the committed root lockfile; downstream projects must update their own locks. See [CHANGELOG.md](CHANGELOG.md).
