import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256 } from "./ids.mjs";

function assertRelativeArtifactPath(path) {
  if (typeof path !== "string" || !path || path.length > 512) throw new Error("artifact path must be a non-empty relative path");
  if (isAbsolute(path) || path.split(/[\\/]/u).includes("..")) throw new Error("artifact path escapes the workspace");
}

export class Workspace {
  constructor(root) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  writeArtifact(runId, artifactId, specification) {
    assertRelativeArtifactPath(specification.path);
    if (typeof specification.content !== "string" || Buffer.byteLength(specification.content) > 1024 * 1024) {
      throw new Error("artifact content must be a string no larger than 1 MiB");
    }
    const runSegment = runId.replace(/[^A-Za-z0-9._-]/gu, "_");
    const locator = ["artifacts", runSegment, specification.path.replaceAll("\\", "/")].join("/");
    const destination = resolve(this.root, locator);
    if (relative(this.root, destination).startsWith(`..${sep}`)) throw new Error("artifact path escapes the workspace");
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.tmp-${randomUUID()}`;
    writeFileSync(temporary, specification.content, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, destination);
    return {
      artifact_id: artifactId,
      locator,
      digest: sha256(specification.content),
      size_bytes: Buffer.byteLength(specification.content),
    };
  }

  readArtifact(locator) {
    const path = resolve(this.root, locator);
    const rel = relative(this.root, path);
    if (rel.startsWith(`..${sep}`) || rel === "..") throw new Error("artifact locator escapes the workspace");
    return readFileSync(path, "utf8");
  }
}
