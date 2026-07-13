import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HouseRuntime } from "../src/index.mjs";
import { fictionalMemoryPolicy, lanternAdapter } from "./fixtures.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, ".lifecycle-demo-output");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

let now = new Date("2032-04-05T09:05:00.000Z");
const schedule = {
  schedule_id: "schedule:lantern:lifecycle-demo",
  time_zone: "UTC",
  sleep_window: { start: "22:00", end: "07:00" },
  opportunities: [
    { rule_id: "rule:lantern:tick", opportunity_type: "tick", at: "09:00", window_minutes: 30, miss_policy: "skip", allowed_states: ["awake"], max_attempts: 2, retry_delay_minutes: 5 },
    { rule_id: "rule:lantern:handoff", opportunity_type: "handoff", at: "21:50", window_minutes: 10, miss_policy: "offer_on_resume", catch_up_minutes: 30, allowed_states: ["awake"], max_attempts: 2, retry_delay_minutes: 5 },
    { rule_id: "rule:lantern:dream", opportunity_type: "dream", at: "06:30", window_minutes: 30, miss_policy: "offer_on_resume", catch_up_minutes: 120, allowed_states: ["sleeping", "awake"], max_attempts: 2, retry_delay_minutes: 5 }
  ]
};

const lifecycleAdapter = {
  async consider({ opportunity }) {
    if (opportunity.opportunity_type === "tick") {
      return {
        decision: "accept",
        reason_codes: ["agent_selected_work"],
        outcome: { type: "initiative", content: { room_id: "room:studio", message: "Create a fictional field note from this opportunity." } }
      };
    }
    if (opportunity.opportunity_type === "feedback") {
      const event = opportunity.source_refs.find((reference) => reference.kind === "event");
      const evidence = opportunity.source_refs.find((reference) => reference.kind === "evidence");
      return {
        decision: "accept",
        reason_codes: ["agent_reflected_after_delivery"],
        outcome: {
          type: "journal",
          content: {
            events: [{ statement: "The selected work was delivered.", epistemic_status: "observed", source_refs: [event], evidence_refs: [evidence.ref_id] }],
            reflections: [{ body: "A delivered artifact can now receive feedback; it is no longer only an intention.", source_refs: [evidence] }],
            intentions: [{ body: "Wait for substantive feedback before revising.", status: "open" }]
          }
        }
      };
    }
    if (opportunity.opportunity_type === "handoff") {
      return {
        decision: "accept",
        reason_codes: ["agent_chose_handoff"],
        outcome: { type: "handoff", content: { open_initiative_refs: [], completed_initiative_refs: [], unresolved_questions: ["What feedback should be revisited after waking?"], source_refs: opportunity.source_refs } }
      };
    }
    return {
      decision: "accept",
      reason_codes: ["agent_chose_dream_record"],
      outcome: { type: "dream", content: { body: "Two fictional fragments changed order without claiming that the scene occurred.", fragment_refs: opportunity.source_refs, affect_words: ["unfinished"] } }
    };
  }
};

const runtime = new HouseRuntime({
  dbPath: join(output, "runtime.db"),
  workspaceDir: join(output, "workspace"),
  clock: () => now,
  memoryPolicy: fictionalMemoryPolicy()
})
  .registerAgent("agent:lantern", lanternAdapter)
  .registerLifecycle("agent:lantern", { schedule, adapter: lifecycleAdapter });

await runtime.pollLifecycle("agent:lantern");
await runtime.drainOutbox(() => undefined);
await runtime.pollLifecycle("agent:lantern");

now = new Date("2032-04-05T21:55:00.000Z");
await runtime.pollLifecycle("agent:lantern");
now = new Date("2032-04-05T22:05:00.000Z");
await runtime.pollLifecycle("agent:lantern");
now = new Date("2032-04-06T06:35:00.000Z");
await runtime.pollLifecycle("agent:lantern");

const summary = {
  state: runtime.getLifeState("agent:lantern").state,
  initiatives: runtime.store.count("initiatives"),
  evidence: runtime.store.count("evidence_bundles"),
  journals: runtime.listLifecycleRecords("agent:lantern", "journal").length,
  handoffs: runtime.listLifecycleRecords("agent:lantern", "handoff").length,
  dreams: runtime.listLifecycleRecords("agent:lantern", "dream").length
};
runtime.close();

if (JSON.stringify(summary) !== JSON.stringify({ state: "sleeping", initiatives: 1, evidence: 1, journals: 1, handoffs: 1, dreams: 1 })) {
  throw new Error(`unexpected lifecycle summary: ${JSON.stringify(summary)}`);
}

console.log("House Runtime lifecycle demo: PASS");
console.log("- tick produced one real Initiative, artifact, and Evidence chain");
console.log("- confirmed delivery produced one agent-authored feedback journal");
console.log("- handoff, sleeping state, and a structurally non-factual dream persisted");
console.log(`- summary: ${JSON.stringify(summary)}`);
console.log(`- output: ${output}`);
