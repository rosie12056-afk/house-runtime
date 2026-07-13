import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runRuntimeClientConformance } from "house-toolkit/src/client-conformance.mjs";
import { createJsonRuntimeExchange, DirectRuntimeClient, HouseRuntime, JsonRuntimeClient, RuntimeService } from "../src/index.mjs";
import { lanternAdapter } from "../demo/fixtures.mjs";

function runtimeEntry(name, clientKind) {
  const root = mkdtempSync(join(tmpdir(), `house-runtime-client-${name}-`));
  const runtime = new HouseRuntime({ dbPath: join(root, "runtime.db"), workspaceDir: join(root, "workspace") })
    .registerAgent("agent:lantern", lanternAdapter);
  const service = new RuntimeService(runtime, { authorize: async ({ authContext }) => authContext?.session === "fictional-valid" ? { subjectId: "user:avery" } : null });
  const authContextProvider = async () => ({ session: "fictional-valid" });
  const client = clientKind === "direct"
    ? new DirectRuntimeClient(service, { authContextProvider })
    : new JsonRuntimeClient(createJsonRuntimeExchange(service, { authContextProvider }));
  return { name, client, close: async () => runtime.close() };
}

test("direct and JSON Runtime clients pass the same candidate suite", async () => {
  const report = await runRuntimeClientConformance({
    createClients: async () => [runtimeEntry("direct-module", "direct"), runtimeEntry("json-transport", "json")],
  });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.summary.clients_checked, 2);
});

test("Runtime service fails closed without host authorization", async () => {
  const root = mkdtempSync(join(tmpdir(), "house-runtime-client-auth-"));
  const runtime = new HouseRuntime({ dbPath: join(root, "runtime.db"), workspaceDir: join(root, "workspace") })
    .registerAgent("agent:lantern", lanternAdapter);
  const client = new DirectRuntimeClient(new RuntimeService(runtime));
  await assert.rejects(client.submit({ roomId: "room:fictional", agentId: "agent:lantern", message: "Should not run.", idempotencyKey: "unauthorized" }), { code: "E_UNAUTHORIZED" });
  assert.equal(runtime.store.count("runs"), 0);
  runtime.close();
});

test("JSON transport attaches authentication outside the client envelope", async () => {
  const root = mkdtempSync(join(tmpdir(), "house-runtime-client-json-auth-"));
  const runtime = new HouseRuntime({ dbPath: join(root, "runtime.db"), workspaceDir: join(root, "workspace") });
  let observed = null;
  const service = new RuntimeService(runtime, { authorize: async ({ authContext }) => { observed = authContext; return { subjectId: "user:avery" }; } });
  const exchange = createJsonRuntimeExchange(service, { authContextProvider: async () => ({ transportSession: "fictional-host-only" }) });
  const response = JSON.parse(await exchange(JSON.stringify({ request_id: "request:fictional:one", method: "run.get", params: { runId: "run:fictional:missing" } })));
  assert.equal(response.ok, true);
  assert.deepEqual(observed, { transportSession: "fictional-host-only" });
  runtime.close();
});
