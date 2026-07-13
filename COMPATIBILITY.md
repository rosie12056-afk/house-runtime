# Compatibility

## Current release

The released alpha line remains pinned to stable v0.2. Runtime `v0.2.0-rc.1` explicitly adopts lifecycle contract candidates and committed lockfile SHAs:

| Dependency | Locked release | Role | Loaded at runtime |
| --- | --- | --- | --- |
| House Protocols | `v0.2.1-rc.1` | Stable v0.2 plus additive lifecycle contracts | Yes |
| House Toolkit | `v0.2.1-rc.1` | Migration, privacy, lifecycle, and conformance checks | No; development dependency only |

The Runtime requires Node.js 22.13 or newer and is tested on Node 22 and 24.

## Upgrade behavior

- Publishing House Protocols v0.2 cannot change Runtime `v0.1.0-alpha.1`; the dependency does not use a floating range.
- Runtime alpha.1 rejects documents whose declared protocol version is not supported by its locked validators.
- Runtime adopts Protocols v0.2 only in a new Runtime release after migration fixtures and Toolkit conformance pass.
- A newer Toolkit may audit an older Runtime, but changing a release gate requires a Runtime commit and CI result. The Toolkit is not silently downloaded or executed by a running Runtime.
- Database schema migrations must be forward-only, versioned, restart-tested, and documented before a Runtime release changes its storage schema.

## Planned matrix

| Runtime | Protocol document profile | Toolkit profile | Status |
| --- | --- | --- | --- |
| `v0.1.0-alpha.1` | `0.1` | Toolkit `v0.1.1` | Tested and released |
| `v0.1.0-alpha.2.1` | writes `0.2` and retains stored `0.1` reads | Toolkit `v0.2.0` | Tested; shared migrations, restart confirmation, lease expiry, cancellation, timeout, and retry boundaries pass |
| `v0.2.0-rc.1` | `0.2` plus additive lifecycle records | Toolkit `v0.2.1-rc.1` | Lifecycle candidate; fake-clock sleep, restart, tick, journal, dream, handoff, delivery, and feedback tests pass |
| planned v0.2 | v0.2 plus lifecycle contracts | Toolkit v0.2 or later compatible profile | Not yet implemented |

Compatibility is established by fixtures and restart tests, not by similar version labels.
