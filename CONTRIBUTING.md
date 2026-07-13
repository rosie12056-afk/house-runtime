# Contributing

House Runtime is experimental. Every state transition, persistence change, and public adapter field requires regression tests, including restart behavior.

```bash
npm install
npm run check
```

Use only fictional users, agents, events, Keels, memories, and artifacts. Do not contribute real conversations, prompts, relationships, credentials, endpoints, databases, or production connector code.

Runtime code must not infer that model output is an external fact, let an adapter mark its own Initiative complete, or write memory without an instance policy decision.
