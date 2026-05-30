/**
 * P3 verification: (a) search surfaces the right primitives cheaply, and
 * (b) the MCP server speaks the protocol — tools/list returns exactly 2 tools and
 * both are callable over stdio.  Run: npm run mcp:smoke
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { formatSearch } from "../src/tools/search.js";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  console.error("  ✓ " + msg);
}
const approxTokens = (s: string) => Math.ceil(s.length / 4);

async function main() {
  // (a) Discovery is cheap and on-target.
  console.error("[1] search relevance + token cost");
  const out = formatSearch("install an ipa and launch it", "summary");
  console.error("---\n" + out + "\n---");
  assert(/RECIPE\] Boot a device/.test(out), "surfaces the boot-install-run recipe");
  assert(/installApp/.test(out), "surfaces agent.installApp wrapper");
  assert(approxTokens(out) < 2000, `search result is <2k tokens (~${approxTokens(out)})`);

  // (b) MCP protocol round-trip against the real server.
  console.error("[2] MCP protocol round-trip");
  const transport = new StdioClientTransport({ command: "npx", args: ["tsx", "src/server.ts"] });
  const client = new Client({ name: "mcp-smoke", version: "1.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    console.error("    tools:", names.join(", "));
    assert(names.length === 2, "exactly 2 tools exposed");
    assert(names.includes("corellium_search") && names.includes("corellium_run"), "the two tools are search + run");

    const searchRes = await client.callTool({
      name: "corellium_search",
      arguments: { query: "capture network traffic", detail: "summary" },
    });
    const sText = (searchRes.content as { type: string; text: string }[])[0]!.text;
    assert(/netdump|pcap|RECIPE/i.test(sText), "search tool returns network-capture results");

    const runRes = await client.callTool({
      name: "corellium_run",
      arguments: { code: "async () => ({ projects: (await corellium.projects.list()).length })" },
    });
    const rText = (runRes.content as { type: string; text: string }[])[0]!.text;
    console.error("    run ->", rText.replace(/\s+/g, " ").slice(0, 160));
    const env = JSON.parse(rText);
    assert(env.ok === true, "run tool executed code against the live API");
    assert(typeof env.result.projects === "number", "run returned a structured result");
  } finally {
    await client.close();
  }

  console.error("\n✓ P3 verified (discovery + MCP server)");
}

main().catch((e) => {
  console.error("mcp-smoke FAILED:", e?.message ?? e);
  process.exit(1);
});
