/**
 * Sandbox executor. Runs model-authored JS inside an isolated-vm V8 isolate with:
 *   - no network, no fs, no Node globals (bare context)
 *   - a host bridge that performs Corellium requests WITH the token attached here
 *   - a destructive-op guardrail (DELETE gated behind allow_destructive)
 *   - binary responses captured to artifacts (handles, not bytes, cross back)
 *   - wall-clock + memory limits
 */
import ivm from "isolated-vm";
import { randomUUID } from "node:crypto";
import { request, redact, type RequestOptions } from "../primitives/client.js";
import { ArtifactStore, guessKind, type ArtifactHandle } from "./artifacts.js";
import { buildPreamble } from "./preamble.js";

export interface RunOptions {
  code: string;
  allowDestructive?: boolean;
  timeoutMs?: number;
  memoryLimitMb?: number;
}

export interface RunResult {
  ok: boolean;
  result?: unknown;
  logs: string[];
  error?: string;
  artifacts: ArtifactHandle[];
  truncated?: boolean;
}

const RESULT_CHAR_CAP = 20000;
const MAX_SLEEP_MS = 60_000;

function isDestructive(opts: RequestOptions): boolean {
  const method = (opts.method ?? "GET").toUpperCase();
  if (method === "DELETE") return true;
  // A few non-DELETE data-loss verbs.
  return /\/(erase|wipe|reset)(\b|\/|$)/i.test(opts.path);
}

interface BridgeContext {
  allowDestructive: boolean;
  store: ArtifactStore;
}

async function handleOp(op: string, args: unknown, ctx: BridgeContext): Promise<unknown> {
  switch (op) {
    case "sleep": {
      const ms = Math.max(0, Math.min(Number((args as { ms?: number })?.ms ?? 0), MAX_SLEEP_MS));
      await new Promise((r) => setTimeout(r, ms));
      return null;
    }
    case "request": {
      const opts = args as RequestOptions;
      if (!opts || typeof opts.path !== "string") {
        throw new Error("request requires { path }");
      }
      if (isDestructive(opts) && !ctx.allowDestructive) {
        throw new Error(
          `BLOCKED: '${opts.method ?? "GET"} ${opts.path}' is destructive. ` +
            `Re-run corellium_run with allow_destructive:true to permit it.`,
        );
      }
      const res = await request(opts);
      if (opts.responseType === "binary") {
        const bytes = res.bytes ?? new Uint8Array();
        const name = opts.path.split("/").filter(Boolean).slice(-2).join("_") || "artifact";
        const kind = guessKind(res.headers["content-type"], name);
        const ext = kind === "image/png" ? ".png" : kind.includes("pcap") ? ".pcap" : ".bin";
        const handle = await ctx.store.save(name + ext, bytes, kind);
        return handle;
      }
      if (opts.responseType === "text") return res.text ?? "";
      return res.json ?? res.text ?? null;
    }
    default:
      throw new Error(`unknown bridge op: ${op}`);
  }
}

export async function runCode(opts: RunOptions): Promise<RunResult> {
  const timeoutMs = Math.max(1000, Math.min(opts.timeoutMs ?? 120_000, 600_000));
  const memoryLimitMb = opts.memoryLimitMb ?? 128;
  const runId = randomUUID().slice(0, 8);
  const store = new ArtifactStore(runId);
  const logs: string[] = [];
  const bridgeCtx: BridgeContext = { allowDestructive: opts.allowDestructive ?? false, store };

  const isolate = new ivm.Isolate({ memoryLimit: memoryLimitMb });
  try {
    const context = await isolate.createContext();
    const jail = context.global;

    const bridgeRef = new ivm.Reference(async (payload: string): Promise<string> => {
      try {
        const { op, args } = JSON.parse(payload);
        const value = await handleOp(op, args, bridgeCtx);
        return JSON.stringify({ value: value ?? null });
      } catch (e) {
        return JSON.stringify({ error: redact(String((e as Error)?.message ?? e)) });
      }
    });
    const logRef = new ivm.Reference((s: string) => {
      if (logs.length < 1000) logs.push(redact(String(s)).slice(0, 4000));
    });

    await jail.set("__bridgeRef", bridgeRef);
    await jail.set("__logRef", logRef);

    await context.eval(buildPreamble());

    // The model supplies an async arrow function expression. Wrap, await, and
    // JSON-stringify the result so it is transferable across the boundary.
    const script = `
      (async () => {
        const __main = (${opts.code});
        if (typeof __main !== 'function') throw new Error('code must be a function expression, e.g. async () => { ... }');
        const __r = await __main();
        const __s = JSON.stringify(__r === undefined ? null : __r);
        return __s === undefined ? 'null' : __s;
      })()
    `;

    const evalPromise = context.eval(script, {
      timeout: timeoutMs,
      promise: true,
      copy: true,
    }) as unknown as Promise<string>;

    const timer = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`run timed out after ${timeoutMs}ms`)), timeoutMs + 500),
    );

    const jsonStr = await Promise.race([evalPromise, timer]);

    let result: unknown;
    let truncated = false;
    if (typeof jsonStr === "string" && jsonStr.length > RESULT_CHAR_CAP) {
      truncated = true;
      result = {
        __truncated: true,
        note: `result was ${jsonStr.length} chars (cap ${RESULT_CHAR_CAP}). Filter/slice inside the sandbox and return less.`,
        preview: JSON.parse(safeSlice(jsonStr, RESULT_CHAR_CAP)),
      };
    } else {
      result = JSON.parse(jsonStr);
    }

    return { ok: true, result, logs, artifacts: store.list(), truncated };
  } catch (e) {
    return {
      ok: false,
      error: redact(String((e as Error)?.message ?? e)),
      logs,
      artifacts: store.list(),
    };
  } finally {
    if (!isolate.isDisposed) isolate.dispose();
  }
}

/** Slice a JSON string to <= cap chars at a structurally safe-ish point (best effort). */
function safeSlice(s: string, cap: number): string {
  const cut = s.slice(0, cap);
  // Try to parse progressively shorter prefixes that still form valid JSON arrays/objects.
  for (let i = cut.length; i > 0; i -= Math.max(1, Math.floor(i / 50))) {
    const candidate = cut.slice(0, i);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      /* keep shrinking */
    }
  }
  return "null";
}
