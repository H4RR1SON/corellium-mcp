/**
 * Host-side Corellium HTTP client.
 *
 * SECURITY: this module is the ONLY place the API token is read or attached.
 * It runs on the host, never inside the isolated-vm sandbox. The sandbox calls
 * `request()` across the Reference bridge; the token is injected here so model
 * code never sees it.
 */
import { config as loadEnv } from "dotenv";

loadEnv();

export interface CorelliumConfig {
  host: string;
  token: string;
  baseUrl: string;
  insecureTls: boolean;
}

let _config: CorelliumConfig | null = null;

export function getConfig(): CorelliumConfig {
  if (_config) return _config;
  const host = process.env.CORELLIUM_API_HOST?.trim();
  const token = process.env.CORELLIUM_API_TOKEN?.trim();
  if (!host) throw new Error("CORELLIUM_API_HOST is not set (see .env.example)");
  if (!token) throw new Error("CORELLIUM_API_TOKEN is not set (see .env.example)");
  const insecureTls = process.env.CORELLIUM_INSECURE_TLS === "1";
  if (insecureTls) {
    // On-prem self-signed escape hatch. Global because Node's global fetch
    // (undici) is not exposed as an importable bare module for a per-request
    // dispatcher. Default (verify on) is used unless explicitly opted out.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  _config = {
    host,
    token,
    baseUrl: `https://${host.replace(/\/+$/, "")}/api`,
    insecureTls,
  };
  return _config;
}

/** Redact the token from any string before it could reach a log or the model. */
export function redact(s: string): string {
  const token = process.env.CORELLIUM_API_TOKEN?.trim();
  if (!token) return s;
  return s.split(token).join("[REDACTED_TOKEN]");
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  /** Path joined to baseUrl, e.g. "/v1/projects". A bare "v1/..." is also accepted. */
  path: string;
  method?: HttpMethod;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** JSON-serialized unless it is a string / Uint8Array (sent verbatim). */
  body?: unknown;
  headers?: Record<string, string>;
  /** Defaults to "json". Use "binary" for screenshots/pcap/dumps, "text" for logs. */
  responseType?: "json" | "text" | "binary";
}

export interface RawResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  json?: unknown;
  text?: string;
  bytes?: Uint8Array;
}

export class CorelliumError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(redact(message));
    this.name = "CorelliumError";
    this.status = status;
    this.body = body;
  }
}

function buildUrl(base: string, path: string, query?: RequestOptions["query"]): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(base + clean);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * Low-level request. The model never calls this directly — the sandbox proxy
 * forwards to it via the bridge, and recipes/wrappers build on top of it.
 */
export async function request(opts: RequestOptions): Promise<RawResponse> {
  const cfg = getConfig();
  const method = opts.method ?? "GET";
  const url = buildUrl(cfg.baseUrl, opts.path, opts.query);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: "application/json",
    ...opts.headers,
  };

  let body: string | Uint8Array | undefined;
  if (opts.body !== undefined && method !== "GET") {
    if (typeof opts.body === "string") {
      body = opts.body;
    } else if (opts.body instanceof Uint8Array) {
      body = opts.body;
    } else {
      body = JSON.stringify(opts.body);
      if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
    }
  }

  const init: RequestInit = { method, headers, body };

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new CorelliumError(0, `network error: ${redact(String(err))}`, null);
  }

  const respHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => (respHeaders[k] = v));

  const responseType = opts.responseType ?? "json";
  const out: RawResponse = { status: res.status, ok: res.ok, headers: respHeaders };

  if (responseType === "binary") {
    out.bytes = new Uint8Array(await res.arrayBuffer());
  } else if (responseType === "text") {
    out.text = await res.text();
  } else {
    const text = await res.text();
    try {
      out.json = text ? JSON.parse(text) : null;
    } catch {
      out.text = text; // non-JSON body (e.g. some error pages)
    }
  }

  if (!res.ok) {
    const detail =
      (out.json && typeof out.json === "object"
        ? JSON.stringify(out.json)
        : out.text) ?? "";
    throw new CorelliumError(res.status, `HTTP ${res.status} ${opts.method ?? "GET"} ${opts.path}: ${detail}`.slice(0, 1000), out.json ?? out.text ?? null);
  }

  return out;
}

/** Convenience: JSON request returning the parsed body directly. */
export async function requestJson<T = unknown>(opts: RequestOptions): Promise<T> {
  const res = await request(opts);
  return (res.json ?? res.text ?? null) as T;
}
