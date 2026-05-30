/**
 * corellium_run — execution. Runs model code in the sandbox and returns a compact
 * JSON envelope { ok, result, logs, artifacts, error?, truncated? }.
 */
import { runCode } from "../sandbox/isolate.js";

export async function formatRun(
  code: string,
  allowDestructive = false,
  timeoutMs?: number,
): Promise<string> {
  const r = await runCode({ code, allowDestructive, timeoutMs });
  const envelope: Record<string, unknown> = {
    ok: r.ok,
    result: r.result ?? null,
    logs: r.logs,
    artifacts: r.artifacts,
  };
  if (r.error) envelope.error = r.error;
  if (r.truncated) envelope.truncated = true;
  return JSON.stringify(envelope, null, 2);
}
