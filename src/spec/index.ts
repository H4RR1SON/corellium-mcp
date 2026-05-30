/**
 * Discovery index for corellium_search. Unifies three sources into one ranked,
 * detail-tunable catalog so the 206-op surface is reachable on demand instead of
 * always-on context:
 *   - operations: every path/verb in the pinned openapi.json
 *   - wrappers:   the hand-written ergonomic API (see sandbox/wrappers.ts)
 *   - recipes:    curated end-to-end flows from src/spec/recipes/*.md
 *
 * Ranking is lexical (term overlap with name/path/tags/summary). It is offline,
 * dependency-free, and fast for this corpus size; semantic ranking is a future add.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type ItemKind = "operation" | "wrapper" | "recipe";

export interface IndexItem {
  kind: ItemKind;
  id: string;
  signature: string;
  summary: string;
  tags: string[];
  method?: string;
  path?: string;
  paramNames?: string[];
  bodyProps?: string[];
  body?: string; // recipes (markdown) / wrapper example
  haystack: string;
}

interface OpenApiSpec {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, JsonSchema> };
}
interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: { name: string; in: string }[];
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
}
interface JsonSchema {
  $ref?: string;
  properties?: Record<string, unknown>;
  allOf?: JsonSchema[];
}

const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete"]);

function resolveRef(spec: OpenApiSpec, schema?: JsonSchema): JsonSchema | undefined {
  if (!schema) return undefined;
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop()!;
    return spec.components?.schemas?.[name];
  }
  return schema;
}

function bodyProps(spec: OpenApiSpec, op: OpenApiOperation): string[] {
  const schema = resolveRef(spec, op.requestBody?.content?.["application/json"]?.schema);
  if (!schema) return [];
  if (schema.properties) return Object.keys(schema.properties);
  if (schema.allOf) {
    return schema.allOf.flatMap((s) => Object.keys(resolveRef(spec, s)?.properties ?? {}));
  }
  return [];
}

function loadOperations(): IndexItem[] {
  const spec = JSON.parse(readFileSync(resolve(__dirname, "openapi.json"), "utf8")) as OpenApiSpec;
  const items: IndexItem[] = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [verb, op] of Object.entries(methods)) {
      if (!HTTP_VERBS.has(verb.toLowerCase())) continue;
      const method = verb.toUpperCase();
      const summary = op.summary ?? op.description ?? "";
      const tags = op.tags ?? [];
      const paramNames = (op.parameters ?? []).map((p) => p.name);
      const props = bodyProps(spec, op);
      items.push({
        kind: "operation",
        id: op.operationId ?? `${method} ${path}`,
        signature: `${method} ${path}`,
        summary,
        tags,
        method,
        path,
        paramNames,
        bodyProps: props,
        haystack: `${op.operationId ?? ""} ${method} ${path} ${tags.join(" ")} ${summary} ${props.join(" ")}`.toLowerCase(),
      });
    }
  }
  return items;
}

/**
 * Wrapper catalog — the model-facing documentation of the ergonomic API defined in
 * sandbox/wrappers.ts. Kept here so search can surface it; keep in sync with wrappers.
 */
const WRAPPERS: Array<{ id: string; signature: string; summary: string; tags: string[]; example?: string }> = [
  { id: "corellium.request", signature: "corellium.request({ method, path, query?, body?, responseType? })", summary: "Raw escape hatch over ANY of the 206 operations. responseType:'binary' returns an artifact handle.", tags: ["raw", "request", "escape-hatch"] },
  { id: "corellium.projects.list", signature: "corellium.projects.list()", summary: "List all projects you can access.", tags: ["projects"] },
  { id: "corellium.projects.instances", signature: "corellium.projects.instances(projectId)", summary: "List instances in a project.", tags: ["projects", "instances"] },
  { id: "corellium.instances.list", signature: "corellium.instances.list(project?)", summary: "List virtual devices, optionally filtered by project id.", tags: ["instances", "devices", "list"] },
  { id: "corellium.instances.create", signature: "corellium.instances.create({ flavor, project, os, name?, patches? })", summary: "Create a virtual device (async; does not wait for boot).", tags: ["instances", "create", "device"] },
  { id: "corellium.instances.createAndBoot", signature: "corellium.instances.createAndBoot({ flavor, project, os, ... })", summary: "Create a device and poll until state='on'. Returns an instance handle.", tags: ["instances", "create", "boot", "device"], example: "const dev = await corellium.instances.createAndBoot({ flavor:'iphone16pro', project:p.id, os:'18.0' });" },
  { id: "corellium.instance", signature: "corellium.instance(id) -> handle", summary: "Handle for one device: get/start/stop/reboot/destroy, screenshot, snapshots, capture, agent().", tags: ["instances", "device", "control"] },
  { id: "instance.start", signature: "instance.start(opts?) / stop(opts?) / reboot() / setState(state)", summary: "Power control. setState('on'|'off') is an alternative to start/stop.", tags: ["instances", "power", "lifecycle"] },
  { id: "instance.screenshot", signature: "instance.screenshot(format='png')", summary: "Capture the screen. Returns an artifact handle {path,bytes,sha256,kind}, not raw bytes.", tags: ["capture", "screenshot", "media"] },
  { id: "instance.snapshots", signature: "instance.snapshots() / takeSnapshot(name) / restoreSnapshot(id)", summary: "List, create, and restore device snapshots.", tags: ["snapshots"] },
  { id: "instance.startNetdump", signature: "instance.startNetdump(filter?) / stopNetdump() / netdumpPcap()", summary: "Packet capture. netdumpPcap() returns a .pcap artifact handle.", tags: ["network", "netdump", "pcap", "capture"] },
  { id: "instance.networkMonitorPcap", signature: "instance.networkMonitorPcap()", summary: "Download the Network Monitor capture as a .pcap artifact handle.", tags: ["network", "monitor", "pcap"] },
  { id: "instance.enableSslsplit", signature: "instance.enableSslsplit(filter?) / disableSslsplit()", summary: "TLS man-in-the-middle (SSL split) for intercepting HTTPS traffic.", tags: ["network", "mitm", "ssl", "tls"] },
  { id: "instance.coreTrace", signature: "instance.enableCoreTrace() / disableCoreTrace() / coreTraceThreads()", summary: "CoreTrace full syscall tracing controls.", tags: ["coretrace", "trace", "syscall", "security"] },
  { id: "instance.agent", signature: "await instance(id).agent() -> agent session", summary: "Wait for the on-device agent (post-boot) and return a session for app/file ops.", tags: ["agent", "on-device"] },
  { id: "agent.installApp", signature: "agent.installApp(devicePath)", summary: "Install an app already present on the device filesystem (AgentInstallBody.path).", tags: ["agent", "app", "install", "ipa", "apk"] },
  { id: "agent.runApp", signature: "agent.runApp(bundleId) / killApp(bundleId) / uninstallApp(bundleId)", summary: "Launch, kill, or uninstall an app by bundle id.", tags: ["agent", "app", "launch"] },
  { id: "agent.appList", signature: "agent.appList()", summary: "List installed apps with bundle ids.", tags: ["agent", "app", "list"] },
  { id: "agent.files", signature: "agent.readFile(path) / writeFile(path, content) / deleteFile(path)", summary: "Device filesystem I/O. readFile returns an artifact handle.", tags: ["agent", "file", "filesystem"] },
  { id: "corellium.snapshots.get", signature: "corellium.snapshots.get(id) / rename(id,name) / del(id)", summary: "Top-level snapshot operations (cross-project).", tags: ["snapshots"] },
];

function loadWrappers(): IndexItem[] {
  return WRAPPERS.map((w) => ({
    kind: "wrapper" as const,
    id: w.id,
    signature: w.signature,
    summary: w.summary,
    tags: w.tags,
    body: w.example,
    haystack: `${w.id} ${w.signature} ${w.tags.join(" ")} ${w.summary}`.toLowerCase(),
  }));
}

function parseFrontMatter(md: string): { meta: Record<string, string>; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: m[2]! };
}

function loadRecipes(): IndexItem[] {
  const dir = resolve(__dirname, "recipes");
  if (!existsSync(dir)) return [];
  const items: IndexItem[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const raw = readFileSync(resolve(dir, file), "utf8");
    const { meta, body } = parseFrontMatter(raw);
    const id = file.replace(/\.md$/, "");
    const tags = (meta.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    const title = meta.title ?? id;
    const when = meta.when ?? "";
    items.push({
      kind: "recipe",
      id,
      signature: title,
      summary: when,
      tags,
      body,
      haystack: `${id} ${title} ${when} ${tags.join(" ")} ${body}`.toLowerCase(),
    });
  }
  return items;
}

let _index: IndexItem[] | null = null;
export function getIndex(): IndexItem[] {
  if (_index) return _index;
  _index = [...loadOperations(), ...loadWrappers(), ...loadRecipes()];
  return _index;
}

const KIND_BOOST: Record<ItemKind, number> = { recipe: 1.5, wrapper: 1.0, operation: 0 };

export interface SearchResult extends IndexItem {
  score: number;
}

export function searchIndex(
  query: string,
  opts: { kind?: ItemKind; limit?: number } = {},
): SearchResult[] {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  const items = getIndex().filter((it) => !opts.kind || it.kind === opts.kind);
  const scored: SearchResult[] = [];
  for (const it of items) {
    let score = 0;
    for (const term of terms) {
      const inId = it.id.toLowerCase().includes(term) || (it.path ?? "").toLowerCase().includes(term);
      const inTags = it.tags.some((t) => t.toLowerCase().includes(term));
      const inSummary = it.summary.toLowerCase().includes(term);
      const inHay = it.haystack.includes(term);
      if (inId) score += 3;
      if (inTags) score += 2;
      if (inSummary) score += 2;
      else if (inHay) score += 1;
    }
    if (score > 0) scored.push({ ...it, score: score + KIND_BOOST[it.kind] });
  }
  scored.sort((a, b) => b.score - a.score || a.signature.length - b.signature.length);
  return scored.slice(0, opts.limit ?? 12);
}

export function countByKind(): Record<ItemKind, number> {
  const out: Record<ItemKind, number> = { operation: 0, wrapper: 0, recipe: 0 };
  for (const it of getIndex()) out[it.kind]++;
  return out;
}
