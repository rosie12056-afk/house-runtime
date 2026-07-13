# House Runtime

House Runtime is an experimental, model-independent runtime for persistent single-user agent systems. It provides durable runs, per-room generation queues, protocol-validated context and evidence, immutable Keel revisions, policy-gated memory writes, local artifacts, and an outbox that survives process restarts.

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

## Five-minute demo

```bash
npm install
npm run demo
```

The demo uses two fictional agents, `Lantern` and `Harbor`. Lantern writes a fictional field note. Harbor receives the artifact through a referenced context entry and writes a review. The demo then closes and reopens the SQLite database to verify that runs, artifacts, evidence, initiatives, memories, Keels, and pending delivery state remain available.

Demo output is written to `.demo-output/`.

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

## Development

```bash
npm run check
```

House Runtime requires Node.js 22.13 or newer and uses the built-in `node:sqlite` module. Node currently labels that API as active development and may print an experimental warning. Database access is isolated behind `RuntimeStore`, and the repository remains an alpha release until that dependency surface is stable.

See [ROADMAP.md](ROADMAP.md), [COMPATIBILITY.md](COMPATIBILITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [SECURITY.md](SECURITY.md).

## Not included

- Model provider clients or prompts.
- Email, Telegram, forum, game, browser, search, or other external connectors.
- Production authentication or a public HTTP server.
- Scheduler, Life Clock, tick, dream, journal, or handoff modules; these are later Runtime milestones.
- House Console.

## License

AGPL-3.0-only.
