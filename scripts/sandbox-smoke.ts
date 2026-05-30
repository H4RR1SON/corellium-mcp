/**
 * P1 verification: prove the sandbox executes model code over the live API,
 * that the token + Node globals are NOT reachable inside the isolate, and that
 * the destructive guardrail fires.  Run: npm run sandbox:smoke
 */
import { runCode } from "../src/sandbox/isolate.js";
import { getConfig } from "../src/primitives/client.js";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  console.error("  ✓ " + msg);
}

async function main() {
  const token = getConfig().token;

  // 1) Functional: model code composes requests and filters in-sandbox.
  console.error("[1] functional run (list instances, project-filtered)");
  const r1 = await runCode({
    code: `async () => {
      const projects = await corellium.get('/v1/projects');
      const pid = projects[0].id;
      const instances = await corellium.request({ path: '/v1/instances', query: { project: pid } });
      console.log('fetched ' + instances.length + ' instances in ' + projects[0].name);
      return instances.map(i => ({ name: i.name, flavor: i.flavor, state: i.state }));
    }`,
  });
  assert(r1.ok, "run succeeded");
  assert(Array.isArray(r1.result), "result is an array of instances");
  console.error("    result:", JSON.stringify(r1.result));
  console.error("    logs:", JSON.stringify(r1.logs));

  // 2) Token isolation: the token must not appear anywhere in the run output.
  console.error("[2] token + secret isolation");
  const dump = JSON.stringify(r1);
  assert(!dump.includes(token), "token string absent from run result/logs");

  // 3) Sandbox surface: Node globals absent inside the isolate.
  const r3 = await runCode({
    code: `async () => ({
      process: typeof process,
      require: typeof require,
      fetch: typeof fetch,
      globalThis_token_leak: Object.getOwnPropertyNames(globalThis).join(','),
    })`,
  });
  assert(r3.ok, "probe run succeeded");
  const probe = r3.result as Record<string, string>;
  console.error("    probe:", JSON.stringify(probe));
  assert(probe.process === "undefined", "process is undefined in isolate");
  assert(probe.require === "undefined", "require is undefined in isolate");
  assert(probe.fetch === "undefined", "fetch is undefined in isolate (no network)");
  assert(!JSON.stringify(r3).includes(token), "token absent from probe output");

  // 4) Guardrail: DELETE without allow_destructive is blocked.
  console.error("[3] destructive guardrail");
  const r4 = await runCode({
    code: `async () => { await corellium.del('/v1/instances/00000000-0000-0000-0000-000000000000'); return 'reached'; }`,
  });
  assert(!r4.ok, "destructive run blocked (ok=false)");
  assert(/BLOCKED/.test(r4.error ?? ""), "error mentions BLOCKED: " + r4.error);

  // 5) Guardrail bypass with explicit opt-in reaches the API (404 from server, not BLOCKED).
  const r5 = await runCode({
    allowDestructive: true,
    code: `async () => { await corellium.del('/v1/instances/00000000-0000-0000-0000-000000000000'); return 'reached'; }`,
  });
  assert(!r5.ok, "delete of nonexistent id still errors");
  assert(!/BLOCKED/.test(r5.error ?? ""), "with allow_destructive it is NOT blocked (server-side error instead): " + r5.error);

  console.error("\n✓ P1 sandbox verified");
}

main().catch((e) => {
  console.error("sandbox-smoke FAILED:", e?.message ?? e);
  process.exit(1);
});
