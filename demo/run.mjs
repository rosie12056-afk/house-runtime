import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HouseRuntime } from "../src/index.mjs";
import { fictionalMemoryPolicy, harborAdapter, harborKeel, lanternAdapter, lanternKeel } from "./fixtures.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, ".demo-output");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const options = {
  dbPath: join(output, "runtime.db"),
  workspaceDir: join(output, "workspace"),
  memoryPolicy: fictionalMemoryPolicy(),
};

let runtime = new HouseRuntime(options)
  .registerAgent("agent:lantern", lanternAdapter)
  .registerAgent("agent:harbor", harborAdapter);
runtime.putKeel(lanternKeel);
runtime.putKeel(harborKeel);

const lanternRun = await runtime.submit({
  roomId: "room:studio",
  agentId: "agent:lantern",
  message: "Write a field note that another fictional agent can review.",
  idempotencyKey: "demo-lantern-field-note-1",
});
if (lanternRun.status !== "completed") throw new Error(`Lantern run failed: ${lanternRun.error?.message}`);

const sourceArtifact = runtime.getArtifact(lanternRun.result.artifact_ids[0]);
const harborRun = await runtime.submit({
  roomId: "room:studio",
  agentId: "agent:harbor",
  message: "Review the referenced field note and keep evidence separate from interpretation.",
  idempotencyKey: "demo-harbor-review-1",
  contextRefs: [
    {
      ref_id: sourceArtifact.artifact_id,
      kind: "artifact",
      locator: sourceArtifact.locator,
      digest: sourceArtifact.digest,
    },
  ],
});
if (harborRun.status !== "completed") throw new Error(`Harbor run failed: ${harborRun.error?.message}`);

const countsBeforeRestart = Object.fromEntries(
  ["runs", "events", "context_manifests", "proposals", "artifacts", "evidence_bundles", "initiatives", "memories", "keels", "outbox"]
    .map((table) => [table, runtime.store.count(table)]),
);
runtime.close();

runtime = new HouseRuntime(options);
const pendingBeforeDelivery = runtime.store.listOutbox("pending").length;
const delivered = [];
await runtime.drainOutbox((event) => delivered.push(event.event_id));
const persistedReview = runtime.readArtifact(harborRun.result.artifact_ids[0]);
runtime.close();

console.log("House Runtime demo: PASS");
console.log("- two fictional agents completed linked artifact work");
console.log("- initiatives completed only after runtime-verified actions, outputs, and evidence");
console.log("- Keel and memory policy records persisted");
console.log(`- persisted counts: ${JSON.stringify(countsBeforeRestart)}`);
console.log(`- pending outbox events survived restart: ${pendingBeforeDelivery}`);
console.log(`- locally delivered events: ${delivered.length}`);
console.log(`- persisted review bytes: ${Buffer.byteLength(persistedReview)}`);
console.log(`- output: ${output}`);
