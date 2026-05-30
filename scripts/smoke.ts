/**
 * P0 live smoke test: prove the host client can authenticate and read.
 * Run: npm run smoke
 */
import { requestJson, getConfig, redact } from "../src/primitives/client.js";

interface Project {
  id: string;
  name: string;
  quotas?: { cores?: number; instances?: number };
}

interface Instance {
  id: string;
  name?: string;
  flavor?: string;
  state?: string;
  type?: string;
}

async function main() {
  const cfg = getConfig();
  console.error(`Tenant: ${cfg.host}\n`);

  const projects = await requestJson<Project[]>({ path: "/v1/projects" });
  console.error(`Projects (${projects.length}):`);
  for (const p of projects.slice(0, 10)) {
    console.error(`  • ${p.name}  [${p.id}]`);
  }

  // Instances across the first project, to confirm a second resource type works.
  if (projects.length > 0) {
    const pid = projects[0]!.id;
    const instances = await requestJson<Instance[]>({
      path: "/v1/instances",
      query: { project: pid },
    });
    console.error(`\nInstances in "${projects[0]!.name}" (${instances.length}):`);
    for (const i of instances.slice(0, 10)) {
      console.error(`  • ${i.name ?? "(unnamed)"}  ${i.flavor ?? ""}  state=${i.state ?? "?"}  [${i.id}]`);
    }
  }

  console.error("\n✓ Auth + read OK");
}

main().catch((e) => {
  console.error("smoke failed:", redact(String(e?.message ?? e)));
  process.exit(1);
});
