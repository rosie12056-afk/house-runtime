# Lifecycle Runtime

Lifecycle scheduling offers bounded opportunities. It does not prescribe personality, interests, topics, or a response.

## Instance configuration

```js
const schedule = {
  schedule_id: "schedule:lantern:example",
  time_zone: "UTC",
  sleep_window: { start: "22:00", end: "07:00" },
  opportunities: [
    {
      rule_id: "rule:lantern:journal",
      opportunity_type: "journal",
      at: "20:00",
      window_minutes: 30,
      miss_policy: "offer_on_resume",
      catch_up_minutes: 60,
      allowed_states: ["awake"],
      max_attempts: 2,
      retry_delay_minutes: 5
    }
  ]
};
```

Every field is explicit. `miss_policy: "skip"` forbids `catch_up_minutes`. `offer_on_resume` requires it. This prevents downtime from silently deleting a lifecycle event while also preventing an unlimited backlog.

## Adapter boundary

```js
runtime.registerLifecycle("agent:lantern", {
  schedule,
  adapter: {
    async consider({ opportunity, life_state, context, signal }) {
      return { decision: "decline", reason_codes: ["agent_not_interested"] };
    }
  }
});

await runtime.pollLifecycle("agent:lantern");
```

The adapter may decline, produce a Journal, Dream, or Handoff proposal appropriate to the Opportunity, or select a local Initiative from a Tick. Runtime-generated identifiers and protocol validation are applied after the decision. The adapter cannot mark an Initiative complete.

## Evidence boundary

- Journal `observed` events require Evidence references.
- Journal `reported` and `inferred` events require source references.
- Reflection and intention fields are not converted into factual events.
- Dream records are structurally `non_factual` and cannot be recast as observations.
- Handoff stores references and unresolved questions; it does not rewrite source records.

## Operational boundary

- Polling is host-controlled and restart-idempotent.
- Opportunity failures use explicit delay and attempt budgets.
- A confirmed Outbox delivery creates a Feedback Opportunity.
- Sleep state is schedule state, not a claim about consciousness or experience.
- Production House integration requires a separate backup, shadow, and migration review.
