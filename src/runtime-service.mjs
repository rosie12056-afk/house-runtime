import { createId } from "./ids.mjs";
import { assertProtocol, validateProtocol } from "house-protocols";

const METHODS = Object.freeze(new Set(["runtime.health", "run.submit", "run.list", "run.get", "evidence.get", "initiative.get", "memory.query", "lifecycle.query"]));
const RESERVED_AUTH_KEYS = Object.freeze(new Set(["auth", "authentication", "authenticated_by", "cookie", "principal", "session", "token"]));

function errorResponse(requestId, code, message) {
  const safeRequestId = typeof requestId === "string" && /^[A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(requestId) && requestId.length <= 160 ? requestId : null;
  const response = { protocol_version: "0.2", request_id: safeRequestId, ok: false, error: { code, message } };
  assertProtocol("runtime_response", response, { profile: "0.2" });
  return response;
}

function containsReservedAuthField(value) {
  if (Array.isArray(value)) return value.some(containsReservedAuthField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => RESERVED_AUTH_KEYS.has(key.toLowerCase()) || containsReservedAuthField(child));
}

function assertOnlyKeys(value, keys, label) {
  for (const key of Object.keys(value)) if (!keys.has(key)) throw Object.assign(new Error(`${label} contains unsupported field: ${key}`), { code: "E_INVALID_PARAMS" });
}

export class RuntimeService {
  constructor(runtime, { authorize = null, runtimeVersion = "0.3.0-rc.3" } = {}) {
    if (!runtime || typeof runtime.submit !== "function") throw new Error("runtime is required");
    this.runtime = runtime;
    this.authorize = authorize;
    this.runtimeVersion = runtimeVersion;
  }

  async handle(request, { authContext = null } = {}) {
    const requestId = request?.request_id;
    if (!request || typeof request !== "object" || Array.isArray(request)) return errorResponse(null, "E_BAD_REQUEST", "request must be an object");
    if (typeof requestId !== "string" || requestId.length === 0 || typeof request.method !== "string" || request.method.length === 0 || !request.params || typeof request.params !== "object" || Array.isArray(request.params)) {
      return errorResponse(requestId, "E_BAD_REQUEST", "request_id, method, and object params are required");
    }
    if (Object.keys(request).some((key) => !new Set(["protocol_version", "request_id", "method", "params"]).has(key))) return errorResponse(requestId, "E_BAD_REQUEST", "request envelope contains unsupported fields");
    if (containsReservedAuthField(request.params)) return errorResponse(requestId, "E_RESERVED_AUTH_FIELD", "authentication identity must be supplied by the host transport");
    if (!METHODS.has(request.method)) return errorResponse(requestId, "E_METHOD_NOT_FOUND", "unsupported Runtime method");
    if (!validateProtocol("runtime_request", request, { profile: "0.2" }).ok) return errorResponse(requestId, "E_BAD_REQUEST", "request does not match the Runtime API contract");

    if (request.method !== "runtime.health") {
      if (typeof this.authorize !== "function") return errorResponse(requestId, "E_UNAUTHORIZED", "host authorization is required");
      let principal;
      try {
        principal = await this.authorize({ method: request.method, authContext });
      } catch {
        return errorResponse(requestId, "E_UNAUTHORIZED", "host authorization failed");
      }
      if (!principal || (typeof principal !== "string" && typeof principal.subjectId !== "string")) return errorResponse(requestId, "E_UNAUTHORIZED", "host authorization failed");
    }

    try {
      const result = await this.#dispatch(request.method, request.params);
      const response = { protocol_version: "0.2", request_id: requestId, ok: true, result };
      assertProtocol("runtime_response", response, { profile: "0.2" });
      return response;
    } catch (error) {
      return errorResponse(requestId, error?.code || "E_RUNTIME_OPERATION", error?.code ? error.message : "Runtime operation failed");
    }
  }

  async #dispatch(method, params) {
    if (method === "runtime.health") {
      assertOnlyKeys(params, new Set(), "runtime.health params");
      return { ok: true, runtime_version: this.runtimeVersion };
    }
    if (method === "run.submit") {
      assertOnlyKeys(params, new Set(["roomId", "agentId", "message", "idempotencyKey", "contextRefs", "capabilityGrant", "timeoutMs", "maxAttempts"]), "run.submit params");
      return this.runtime.submit(params);
    }
    if (method === "run.list") {
      assertOnlyKeys(params, new Set(["status", "limit"]), "run.list params");
      return this.runtime.listRuns({ status: params.status ?? null, limit: params.limit ?? 50 });
    }
    if (method === "run.get") {
      assertOnlyKeys(params, new Set(["runId"]), "run.get params");
      if (typeof params.runId !== "string" || params.runId.length === 0) throw Object.assign(new Error("runId is required"), { code: "E_INVALID_PARAMS" });
      return this.runtime.getRun(params.runId);
    }
    if (method === "evidence.get") {
      assertOnlyKeys(params, new Set(["runId"]), "evidence.get params");
      if (typeof params.runId !== "string" || params.runId.length === 0) throw Object.assign(new Error("runId is required"), { code: "E_INVALID_PARAMS" });
      return this.runtime.getEvidence(params.runId);
    }
    if (method === "initiative.get") {
      assertOnlyKeys(params, new Set(["runId"]), "initiative.get params");
      if (typeof params.runId !== "string" || params.runId.length === 0) throw Object.assign(new Error("runId is required"), { code: "E_INVALID_PARAMS" });
      return this.runtime.getInitiative(params.runId);
    }
    if (method === "memory.query") {
      assertOnlyKeys(params, new Set(["subjectId", "limit", "includeQuarantined"]), "memory.query params");
      return this.runtime.listMemories(params.subjectId, params.limit ?? 20, { includeQuarantined: params.includeQuarantined ?? false });
    }
    assertOnlyKeys(params, new Set(["subjectId", "kind", "limit"]), "lifecycle.query params");
    if (!new Set(["journal", "dream", "handoff"]).has(params.kind)) throw Object.assign(new Error("kind must be journal, dream, or handoff"), { code: "E_INVALID_PARAMS" });
    return this.runtime.listLifecycleRecords(params.subjectId, params.kind, params.limit ?? 20);
  }
}

function clientError(error) {
  const failure = new Error(error?.message || "Runtime request failed");
  failure.code = error?.code || "E_RUNTIME_REQUEST";
  return failure;
}

class RuntimeClientBase {
  async health() { return this.request("runtime.health", {}); }
  async submit(params) { return this.request("run.submit", params); }
  async listRuns(params = {}) { return this.request("run.list", params); }
  async getRun(runId) { return this.request("run.get", { runId }); }
  async getEvidence(runId) { return this.request("evidence.get", { runId }); }
  async getInitiative(runId) { return this.request("initiative.get", { runId }); }
  async queryMemories(params) { return this.request("memory.query", params); }
  async queryLifecycle(params) { return this.request("lifecycle.query", params); }

  unwrap(response) {
    if (!response || typeof response !== "object" || typeof response.ok !== "boolean") throw Object.assign(new Error("invalid Runtime response"), { code: "E_BAD_RESPONSE" });
    if (!response.ok) throw clientError(response.error);
    return response.result;
  }
}

export class DirectRuntimeClient extends RuntimeClientBase {
  constructor(service, { authContextProvider = async () => null } = {}) {
    super();
    if (!service || typeof service.handle !== "function") throw new Error("RuntimeService is required");
    this.service = service;
    this.authContextProvider = authContextProvider;
  }

  async request(method, params = {}) {
    const envelope = { protocol_version: "0.2", request_id: createId("request"), method, params: structuredClone(params) };
    return this.unwrap(await this.service.handle(envelope, { authContext: await this.authContextProvider() }));
  }
}

export class JsonRuntimeClient extends RuntimeClientBase {
  constructor(exchange) {
    super();
    if (typeof exchange !== "function") throw new Error("JSON Runtime exchange is required");
    this.exchange = exchange;
  }

  async request(method, params = {}) {
    const envelope = { protocol_version: "0.2", request_id: createId("request"), method, params: structuredClone(params) };
    const raw = await this.exchange(JSON.stringify(envelope));
    let response;
    try {
      response = JSON.parse(raw);
    } catch {
      throw Object.assign(new Error("JSON Runtime exchange returned malformed JSON"), { code: "E_BAD_RESPONSE" });
    }
    return this.unwrap(response);
  }
}

export function createJsonRuntimeExchange(service, { authContextProvider = async () => null } = {}) {
  if (!service || typeof service.handle !== "function") throw new Error("RuntimeService is required");
  return async (raw) => {
    let request;
    try {
      request = JSON.parse(raw);
    } catch {
      return JSON.stringify(errorResponse(null, "E_BAD_REQUEST", "request body is not valid JSON"));
    }
    const response = await service.handle(request, { authContext: await authContextProvider() });
    return JSON.stringify(response);
  };
}
