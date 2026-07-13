# Roadmap

House Runtime executes the contracts defined by House Protocols and uses House Toolkit during development and release checks. Milestones are gated by durable behavior, not feature count.

For the five-repository dependency timeline, see the canonical [House Ecosystem Roadmap](https://github.com/rosie12056-afk/house-protocols/blob/main/ECOSYSTEM-ROADMAP.md).

| Milestone | Target gate | What it adds | Problem solved | Primary users |
| --- | --- | --- | --- | --- |
| `v0.1.0-alpha.1` | Released | Durable Runs, per-room queues, proposal recovery, Context Manifests, artifacts, runtime-derived Evidence and Initiative completion, immutable Keel revisions, policy-gated memory, and durable Outbox | Proves that a model-independent agent workflow can survive restart without letting model claims replace execution results | Runtime evaluators and early implementers |
| `v0.1.0-alpha.2` | Released after Protocols v0.2 RC and Toolkit v0.2 conformance | Scheduler leases, cancellation, timeout, fake-clock tests, confirmation challenges, Resignature execution, fuller Memory Port, audit events, and retry budgets | Makes long-running and risky work controllable, testable, and recoverable | Persistent-agent builders |
| v0.2 | Released after alpha.2 control and lifecycle fixture conformance | Life Clock, sleep windows, bounded opportunities, journal, dream, handoff, restart catch-up, and Initiative-to-delivery-to-feedback loops | Adds 24-hour continuity without turning autonomy into repetitive task reports or ungrounded memory | Single-user continuous-agent deployments |
| v0.3 | Candidate work on `t4-portability`; two adapters and two clients pass conformance, release requires adapter integration | Asynchronous Memory Adapter API, two standalone adapter implementations, transport-neutral Runtime Service, two client implementations, connector capability boundaries, migration tooling, and the release gate for optional Anchor and Console repositories | Proves that Runtime APIs are not tied to one database, UI, transport, or private House instance | Adapter and client authors |

## Release gates

- Alpha.2 must consume Protocols v0.2 explicitly and pass Toolkit v0.2 conformance; Protocols v0.2 is never adopted automatically.
- v0.2 must pass restart tests across sleep, tick, journal, dream, and handoff boundaries using a fake clock before real-time scheduling is enabled.
- v0.3 has two independent Memory Adapter implementations and two clients under candidate conformance. The public API remains unstable until the Runtime itself uses durable asynchronous adapter operations.
- Adapter conformance alone does not complete v0.3. Runtime must durably queue adapter writes, retry them after restart, and expose delivery state before the embedded v0.2 port can be retired.
- Production House remains separate. Public Runtime work is not deployed into a live instance without backup, shadow execution, and instance-specific review.

See [COMPATIBILITY.md](COMPATIBILITY.md) for current locks.
