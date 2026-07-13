import { createHash, randomUUID } from "node:crypto";

export function createId(kind) {
  return `${kind}:${randomUUID()}`;
}

export function runScopedId(kind, runId, suffix = "") {
  const token = runId.startsWith("run:") ? runId.slice(4) : runId;
  return `${kind}:${token}${suffix ? `:${suffix}` : ""}`;
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function isoTime(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("clock returned an invalid time");
  return date.toISOString();
}
