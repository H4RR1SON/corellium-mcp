/**
 * Fetch and pin the Corellium OpenAPI spec from the configured tenant.
 * Writes src/spec/openapi.json. Run: npm run spec:pull
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request, getConfig, redact } from "../src/primitives/client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../src/spec/openapi.json");

async function main() {
  const cfg = getConfig();
  console.error(`Fetching openapi.json from ${cfg.baseUrl}/openapi.json …`);
  const res = await request({ path: "/openapi.json", responseType: "json" });
  const spec = res.json as {
    openapi?: string;
    info?: { title?: string; version?: string };
    paths?: Record<string, Record<string, unknown>>;
  };

  const paths = spec.paths ?? {};
  let ops = 0;
  const byTag: Record<string, number> = {};
  for (const methods of Object.values(paths)) {
    for (const [verb, op] of Object.entries(methods)) {
      if (!["get", "post", "put", "patch", "delete"].includes(verb.toLowerCase())) continue;
      ops++;
      const tags = (op as { tags?: string[] })?.tags ?? ["(untagged)"];
      for (const t of tags) byTag[t] = (byTag[t] ?? 0) + 1;
    }
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(spec, null, 2));

  console.error(
    `Pinned: ${spec.info?.title} v${spec.info?.version} (OpenAPI ${spec.openapi})`,
  );
  console.error(`  ${Object.keys(paths).length} path templates · ${ops} operations`);
  console.error(`  → ${OUT}`);
}

main().catch((e) => {
  console.error("pull-spec failed:", redact(String(e?.message ?? e)));
  process.exit(1);
});
