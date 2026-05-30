/**
 * Artifact store. Binary/large Corellium responses (screenshots, pcaps, CoreTrace
 * and RAM dumps) are written to disk on the HOST and represented to the model as
 * a small handle, never as raw bytes. This keeps tool-result tokens tiny.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

export interface ArtifactHandle {
  /** Logical name, e.g. "screenshot.png". */
  name: string;
  /** Path relative to the project root, e.g. "artifacts/<runId>/screenshot.png". */
  path: string;
  /** Size in bytes. */
  bytes: number;
  /** sha256 hex of the content. */
  sha256: string;
  /** Best-effort MIME/kind, e.g. "image/png". */
  kind: string;
}

const ROOT = resolve(process.cwd(), "artifacts");

export class ArtifactStore {
  readonly runId: string;
  private handles: ArtifactHandle[] = [];

  constructor(runId: string) {
    this.runId = runId;
  }

  async save(name: string, bytes: Uint8Array, kind = "application/octet-stream"): Promise<ArtifactHandle> {
    const safeName = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "artifact.bin";
    const dir = resolve(ROOT, this.runId);
    await mkdir(dir, { recursive: true });
    const abs = resolve(dir, safeName);
    await writeFile(abs, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const handle: ArtifactHandle = {
      name: safeName,
      path: `artifacts/${this.runId}/${safeName}`,
      bytes: bytes.byteLength,
      sha256,
      kind,
    };
    this.handles.push(handle);
    return handle;
  }

  list(): ArtifactHandle[] {
    return this.handles;
  }
}

/** Guess a kind from a content-type header or path suffix. */
export function guessKind(contentType?: string, name?: string): string {
  if (contentType) return contentType.split(";")[0]!.trim();
  if (name?.endsWith(".png")) return "image/png";
  if (name?.endsWith(".pcap")) return "application/vnd.tcpdump.pcap";
  return "application/octet-stream";
}
