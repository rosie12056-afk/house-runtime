# House Runtime

House Runtime is an experimental, model-independent runtime for persistent single-user agent systems. It provides durable runs, per-room generation queues, protocol-validated context and evidence, immutable Keel revisions, policy-gated memory writes, local artifacts, and an outbox that survives process restarts.

Runtime v0.2 adds a host-polled 24-hour lifecycle on top of alpha.2 control. It locks stable Protocols and Toolkit lifecycle tags; neither dependency floats automatically.

The unreleased `t4-portability` branch contains a v0.3 Memory Port candidate. Two standalone adapters use their own data files rather than RuntimeStore tables: `SQLiteMemoryAdapter` and `JsonFileMemoryAdapter`. Both expose an asynchronous API and pass the same Toolkit conformance suite. The released Runtime still uses the v0.2 embedded port until durable adapter-operation delivery is complete.

The branch also contains a transport-neutral `RuntimeService`, a direct module client, and a JSON serialization client. Sensitive methods fail closed without a host authorization callback. Authentication context is attached by the host transport and is never accepted from request parameters.

The runtime contains no real House instance, agent personality, relationship, schedule, connector, or private data.

## House open-source stack

The three repositories form one explicit chain:

1. **[House Protocols](https://github.com/rosie12056-afk/house-protocols)** defines what records mean and which trust boundaries must hold.
2. **[House Toolkit](https://github.com/rosie12056-afk/house-toolkit)** checks protocol, evidence, completion, and publication rules.
3. **[House Runtime](https://github.com/rosie12056-afk/house-runtime)** performs durable execution under those contracts.

This repository is the execution layer. It does not redefine protocol truth or ship private instance policy. See [ROADMAP.md](ROADMAP.md) and [COMPATIBILITY.md](COMPATIBILITY.md).

## Alpha flow

1. A request Event and queued Run are committed before execution.
2. A per-room queue prevents two generations from running in the same room at once.
3. A Context Manifest records references without copying source bodies.
4. A model adapter returns a proposal. The proposal is persisted before side effects.
5. The runtime writes artifacts and calculates their digests.
6. Evidence is generated from actual runtime results.
7. An Initiative becomes `completed` only after successful actions, outputs, and Evidence exist.
8. An agent-authored reflection is stored only when the instance Memory Policy allows or quarantines it.
9. The response Event enters a durable Outbox.
10. A restarted process can resume queued or interrupted Runs without asking the adapter to regenerate a saved proposal.

## Execution control

- Every execution attempt acquires a persisted Scheduler Lease with a monotonic fencing token. A second Runtime cannot execute the same Run until an old lease expires.
- Adapter generation has a bounded timeout and receives an `AbortSignal`. Cancellation and timeout occur before proposal materialization, so a late model response cannot write artifacts.
- Each Run has a persisted retry budget. Exhausted attempts cannot be reset by a model response.
- A `capability_grant` with `confirmation_mode: "each_use"` creates a durable confirmation challenge before generation starts.
- Confirmation requires an instance-supplied `confirmationVerifier`. The Runtime does not trust a caller-provided user name, request header, or model statement as authentication.
- Control transitions are written to an audit log without storing authentication secrets.

The Runtime does not implement login or session verification itself. A host application verifies its Secure/HttpOnly session and returns only a verified subject identifier from `confirmationVerifier`.

## Five-minute demo

```bash
npm install
npm run demo
npm run demo:lifecycle
```

The demo uses two fictional agents, `Lantern` and `Harbor`. Lantern writes a fictional field note. Harbor receives the artifact through a referenced context entry and writes a review. The demo then closes and reopens the SQLite database to verify that runs, artifacts, evidence, initiatives, memories, Keels, and pending delivery state remain available.

Demo output is written to `.demo-output/`.

The lifecycle demo uses an explicit fictional UTC schedule and fake time. It shows `tick -> Initiative -> artifact/Evidence -> delivery -> feedback journal`, then handoff, sleeping state, and a structurally non-factual dream. Its output is written to `.lifecycle-demo-output/`.

## 24-hour lifecycle

- An Instance must explicitly configure each subject's IANA timezone, sleep window, opportunity windows, allowed states, missed-window policy, retry budget, and retry delay. The Runtime ships no default city, schedule, interest, or topic selector.
- The host calls `pollLifecycle()`. Polling is idempotent across restart and does not start an invisible infinite timer.
- The lifecycle adapter receives a structured Opportunity and can accept or decline it. The Runtime supplies no personality prompt and does not require an Agent to produce work.
- Adapter failures back off and stop at the configured attempt budget.
- Journal events marked observed require Evidence. Reports and inferences require source references. Dreams are always `non_factual`.
- Delivery creates a feedback Opportunity, allowing Initiative work to continue through a result and later reflection instead of stopping at “I thought about it.”

See [LIFECYCLE.md](LIFECYCLE.md) for the schedule and adapter contracts.

## Adapter boundary

An adapter implements one method:

```js
const adapter = {
  async generate({ event, context }) {
    return {
      response_text: "A response from a fictional adapter.",
      work: {
        goal: "Create a durable artifact.",
        artifacts: [{ path: "note.txt", content: "Fictional content.\n" }],
        reflection: "A private, agent-authored reflection candidate."
      }
    };
  }
};
```

The adapter cannot set an Initiative to `completed`, invent an action result, or write memory directly. The runtime derives those records from actual execution and instance policy.

## Keel and memory

- Keel documents use `house-protocols` and are stored as immutable `(keel_id, revision)` records.
- The runtime does not ship a default Keel or interpret its philosophical meaning.
- Real Keels remain Instance data.
- Memory candidates require an instance-provided policy callback. No callback means no memory write.
- Memory content, Evidence, and retrieval confidence remain separate concepts.
- Accepted agent reflection creates an append-only Resignature linked to the source Event and runtime-derived Evidence; it never overwrites the source memory.
- `SQLiteMemoryPort` is the alpha.2 local implementation. The interface is explicit but not stable until a second independent adapter passes v0.3 conformance.
- The v0.3 candidate adapters require idempotent operation IDs and compare-and-append Resignatures. A stale head fails with `E_RESIGNATURE_CONFLICT`; it never silently forks a subject's interpretation chain.

## Development

```bash
npm run check
```

House Runtime requires Node.js 22.13 or newer and uses the built-in `node:sqlite` module. Node currently labels that API as active development and may print an experimental warning. Database access is isolated behind `RuntimeStore`, and the repository remains an alpha release until that dependency surface is stable.

See [LIFECYCLE.md](LIFECYCLE.md), [MIGRATION.md](MIGRATION.md), [ROADMAP.md](ROADMAP.md), [COMPATIBILITY.md](COMPATIBILITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [SECURITY.md](SECURITY.md).

## Not included

- Model provider clients or prompts.
- Email, Telegram, forum, game, browser, search, or other external connectors.
- Production authentication or a public HTTP server.
- A built-in model provider, default lifecycle prompt, or private House schedule.
- House Console.

## License

AGPL-3.0-only.
