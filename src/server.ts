/**
 * Corellium MCP server (stdio). Exposes exactly two tools — corellium_search and
 * corellium_run — over the full 206-operation Corellium API. The model discovers
 * primitives on demand (search) and executes TypeScript against a typed client in a
 * token-isolated sandbox (run), instead of paying for 206 tool schemas every turn.
 *
 * stdout is the MCP transport — never write to it. All logs go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatSearch } from "./tools/search.js";
import { formatRun } from "./tools/run.js";
import { getConfig } from "./primitives/client.js";
import { countByKind } from "./spec/index.js";

const RUN_DESCRIPTION = `Execute JavaScript against the Corellium platform in a secure sandbox. THIS IS THE PRIMARY TOOL.

Provide \`code\` as an async arrow function. In scope:
  • corellium  — typed client over the ENTIRE Corellium API (206 ops)
       - corellium.request({ method, path, query?, body?, responseType? })  // any endpoint
       - corellium.projects.list()/get(id)
       - corellium.instances.list(project?)/get(id)/create(opts)/createAndBoot(opts)
       - corellium.instance(id)  -> { get, start, stop, reboot, setState, destroy,
                                       screenshot, snapshots, takeSnapshot, restoreSnapshot,
                                       startNetdump, netdumpPcap, enableSslsplit,
                                       enableCoreTrace, agent, waitForState, ... }
       - await corellium.instance(id).agent()  -> { appList, installApp, runApp,
                                       killApp, uninstallApp, readFile, writeFile, ... }
  • sleep(ms)   — for polling loops
  • console.log — captured and returned in \`logs\`
Returns JSON { ok, result, logs, artifacts, error?, truncated? }.

Guidance:
  • Call corellium_search FIRST to find the right operation/wrapper/recipe.
  • Compose multi-step workflows in ONE run; filter/slice large data IN the sandbox and
    return only what you need (results are size-capped).
  • Binary responses (screenshots, pcaps, dumps) come back as artifact HANDLES
    { name, path, bytes, sha256, kind } written to disk — never raw bytes.
  • DELETE / erase / wipe are blocked unless you set allow_destructive: true.

Example:
  async () => {
    const [p] = await corellium.projects.list();
    const list = await corellium.instances.list(p.id);
    return list.filter(i => i.state === 'on').map(i => i.name);
  }`;

const SEARCH_DESCRIPTION = `Search the Corellium capability catalog: REST operations (206), ergonomic wrappers, and end-to-end recipes. Call this BEFORE corellium_run to find the exact primitive to use, then write code against it in corellium_run.

\`detail\`: 'name' (signatures only) | 'summary' (default) | 'full' (params/body/call template or full recipe).
\`kind\`: optionally restrict to 'operation' | 'wrapper' | 'recipe'.

Examples: "install an ipa and launch it", "capture network traffic", "snapshot then restore", "list jailbroken devices".`;

async function main() {
  // Fail fast with a clear message if the tenant is not configured.
  getConfig();

  const server = new McpServer({ name: "corellium-mcp", version: "0.1.0" });

  server.registerTool(
    "corellium_search",
    {
      title: "Search Corellium capabilities",
      description: SEARCH_DESCRIPTION,
      inputSchema: {
        query: z.string().describe("What you want to do, in natural language."),
        detail: z.enum(["name", "summary", "full"]).optional().describe("Verbosity (default 'summary')."),
        kind: z.enum(["operation", "wrapper", "recipe"]).optional().describe("Restrict to one source."),
        limit: z.number().int().min(1).max(40).optional().describe("Max results (default 12)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, detail, kind, limit }) => ({
      content: [{ type: "text", text: formatSearch(query, detail ?? "summary", kind, limit ?? 12) }],
    }),
  );

  server.registerTool(
    "corellium_run",
    {
      title: "Run code against Corellium",
      description: RUN_DESCRIPTION,
      inputSchema: {
        code: z.string().describe("An async arrow function, e.g. async () => { ... }, using the in-scope `corellium` client."),
        allow_destructive: z.boolean().optional().describe("Permit DELETE/erase/wipe operations (default false)."),
        timeout_ms: z.number().int().min(1000).max(600000).optional().describe("Wall-clock limit (default 120000)."),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ code, allow_destructive, timeout_ms }) => ({
      content: [{ type: "text", text: await formatRun(code, allow_destructive ?? false, timeout_ms) }],
    }),
  );

  const counts = countByKind();
  const cfg = getConfig();
  process.stderr.write(
    `corellium-mcp ready · tenant ${cfg.host} · index ${counts.operation} ops / ${counts.wrapper} wrappers / ${counts.recipe} recipes\n`,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write(`corellium-mcp failed to start: ${e?.message ?? e}\n`);
  process.exit(1);
});
