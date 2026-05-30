<div align="center">

# Corellium MCP

### A code-mode [Model Context Protocol](https://modelcontextprotocol.io) server for [Corellium](https://www.corellium.com) — the entire mobile-security platform behind **two tools**, not two hundred.

[![MCP](https://img.shields.io/badge/Model_Context_Protocol-server-6E56CF)](https://modelcontextprotocol.io)
[![Pattern](https://img.shields.io/badge/pattern-code--mode-0EA5E9)](#why-code-mode)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Sandbox](https://img.shields.io/badge/sandbox-isolated--vm-F59E0B)](https://github.com/laverdet/isolated-vm)
[![License](https://img.shields.io/badge/license-MIT-black)](./LICENSE)

</div>

---

Corellium's REST API exposes **206 operations** across virtual iOS/Android devices, snapshots,
the on-device agent, network capture, CoreTrace, HyperTrace, kernel hooks, and the MATRIX
security-assessment engine. The naïve way to wrap that for an LLM is one MCP tool per
operation — which injects **~90k+ tokens of JSON schemas into the model's context on every
single turn**, before it has even read your request, and pushes the model far past the
empirical ~10–15-tool ceiling where tool-selection accuracy falls off a cliff.

**Corellium MCP takes the approach Anthropic and Cloudflare both published instead: _code
execution_.** The model writes small TypeScript snippets against a typed `corellium` client
and runs them in a secure V8 sandbox. The 206-operation catalog becomes a *discovery step*
(`corellium_search`) rather than always-on context. Net result: the whole platform fits in
**~2k tokens of always-on surface**, and the model orchestrates multi-step device workflows
in a single tool call.

```
                          MODEL (Claude / GPT / …)
                                  │  sees ONLY 2 tools  (~2k tokens, not ~90k)
                 ┌────────────────┴─────────────────┐
                 ▼                                    ▼
        ┌─────────────────┐                 ┌────────────────────────┐
        │ corellium_search│  discovery       │ corellium_run           │  execution
        │ query · detail  │  (on demand)     │ code · allow_destructive│  (the workhorse)
        └────────┬────────┘                 └───────────┬────────────┘
                 │ ranks over                            │ runs model TS in
                 ▼                                        ▼
        ┌─────────────────┐               ┌───────────────────────────────────┐
        │ Spec Index      │               │  SANDBOX  (isolated-vm · V8)        │
        │ • 206 ops       │               │  no network · no fs · no Node       │
        │ • ergonomic     │               │  globals · mem + wall-clock caps    │
        │   wrappers      │               │  in scope: `corellium`, `console`,  │
        │ • recipes       │               │  `sleep`, `artifacts`               │
        └─────────────────┘               └────────────────┬────────────────────┘
                                                            │ __bridge(op,args)
                                          ═══════════ security boundary ═══════════
                                                            ▼   token lives ONLY here
                                          ┌───────────────────────────────────┐
                                          │  HOST BRIDGE                        │
                                          │  • injects Bearer token             │
                                          │  • destructive-op guardrail         │
                                          │  • binary → artifact handle on disk │
                                          └────────────────┬────────────────────┘
                                                            ▼ HTTPS
                                            <tenant>.enterprise.corellium.com/api/v1/*
```

> The model writes JavaScript against a typed `corellium` client inside a token-isolated V8
> sandbox; it discovers the 206-op surface on demand instead of paying for it every turn.

---

## Contents

- [Why code mode](#why-code-mode)
- [The two tools](#the-two-tools)
- [Security model](#security-model)
- [Quick start](#quick-start)
- [Use with Claude Code](#use-with-claude-code)
- [The quality evaluator](#the-quality-evaluator)
- [Architectural decisions](#architectural-decisions)
- [Project structure](#project-structure)
- [Status & roadmap](#status--roadmap)
- [Prior art & references](#prior-art--references)

---

## Why code mode

Every tool you register with an MCP client is loaded into the model's context **on every
turn**, as a full JSON Schema. Two compounding problems follow:

1. **Context tax.** Corellium's spec is 355 KB / 206 operations. Exposed as individual tools,
   that is roughly **90k–120k tokens of schemas** the model re-reads before each reply —
   slower, more expensive, and crowding out your actual task.
2. **Decision degradation.** Tool-selection accuracy degrades as the option count climbs;
   the practical ceiling is **~10–15 tools**. A 68-to-206-tool server blows straight past it,
   and mis-picks climb.

Both [Anthropic](https://www.anthropic.com/engineering/code-execution-with-mcp) (Nov 2025) and
[Cloudflare](https://blog.cloudflare.com/code-mode-mcp/) (Feb 2026) converged on the same fix:
**ship one execution primitive over a typed API, and make the catalog a discovery step.**
Anthropic reported a 150k → 2k token reduction (98.7%); Cloudflare reported 99.9% on a
2,500-endpoint API. Corellium MCP applies that pattern to mobile-security tooling.

| | Naïve MCP (one tool per op) | **Corellium MCP (code mode)** |
|---|---|---|
| Always-on tools | 206 | **2** |
| Always-on context | ~90k+ tokens | **~2k tokens** |
| Multi-step workflow | N round-trips through the model | **1 `run` call** |
| Intermediate data (e.g. 200 instances) | flows through context | **filtered in-sandbox** |
| Binary blobs (screenshots, pcap, dumps) | base64 into context | **saved to disk, handle returned** |
| Discovery | always loaded | **on demand via `corellium_search`** |

---

## The two tools

### `corellium_search` — discovery (cheap, read-only)

Ranks across the pinned OpenAPI surface, the hand-written ergonomic wrappers, and curated
recipes. Returns signatures at a chosen verbosity so the model spends tokens only on what it
needs.

```jsonc
{
  "query": "install an ipa and launch it",
  "detail": "summary",          // "name" | "summary" | "full"
  "kind":   "wrapper"            // optional: "operation" | "wrapper" | "recipe"
}
```

### `corellium_run` — execution (the workhorse)

Runs a model-authored async function against the in-sandbox `corellium` client and returns a
size-capped JSON result, captured `console.log` output, and any artifact handles.

```jsonc
{
  "code": "async () => { /* TypeScript against `corellium` */ }",
  "allow_destructive": false,   // DELETE/erase are gated behind this opt-in
  "timeout_ms": 120000
}
```

**Example the model might write** — boot a device, install an app, run it, screenshot:

```js
async () => {
  const [project] = await corellium.get('/v1/projects');
  const device = await corellium.instances.createAndBoot({
    project: project.id, flavor: 'iphone16pro', os: '18.0',
  });
  const agent = await device.agent();
  await agent.installApp('https://example.com/app.ipa');
  await agent.runApp('com.example.app');
  const shot = await device.screenshot();        // → artifact handle, NOT base64 bytes
  return { instance: device.id, screenshot: shot.path };
}
```

The model sees `{ instance, screenshot: "artifacts/<run>/screenshot.png" }` — a few tokens —
while the PNG sits on disk. It filters, loops, and composes inside the sandbox; only the
distilled result crosses back.

---

## Security model

This server holds a live API token and runs **model-generated code**. The design keeps those
two facts apart.

```
  Model code  ──calls──▶  corellium.request(...)  ──bridge──▶  HOST  ──HTTPS+Bearer──▶  Corellium
   (sandbox)                  (no token here)                 (token here)
```

- **The token never enters the sandbox.** It is read and attached only in `src/primitives/client.ts`,
  on the host side of the bridge. Inside the isolate, `process`, `require`, `fetch`, and any
  environment access are **`undefined`** (verified by an automated isolation probe).
- **Real isolation, not `eval`.** Code runs in [`isolated-vm`](https://github.com/laverdet/isolated-vm) —
  a dedicated V8 isolate with its own heap, a hard memory limit, a wall-clock timeout, and **no
  network and no filesystem**. The only way out is the typed bridge.
- **Destructive-op guardrail.** `DELETE` (and `erase`/`wipe`/`reset` paths) are **blocked by
  default** and return a clear message; the model must re-issue with `allow_destructive: true`
  to proceed. Read and create operations are unrestricted.
- **Secret redaction.** The token string is scrubbed from every error, log line, and result
  before it can reach the model or a transcript.
- **Blobs stay out of context.** Screenshots, pcaps, CoreTrace/RAM dumps are written to
  `artifacts/<run-id>/` and represented as `{ name, path, bytes, sha256, kind }` handles.

---

## Quick start

> Requires Node ≥ 20 and a Corellium account (cloud, Enterprise, or on-prem) with an API token.

```bash
git clone https://github.com/H4RR1SON/corellium-mcp.git
cd corellium-mcp
npm install

cp .env.example .env          # then fill in CORELLIUM_API_HOST + CORELLIUM_API_TOKEN
npm run spec:pull             # pin your tenant's OpenAPI spec (206 ops)
npm run gen:types             # generate TypeScript types from the spec
npm run smoke                 # live check: lists your projects + instances
```

`.env`:

```ini
CORELLIUM_API_HOST=your-instance.enterprise.corellium.com   # host only, no scheme / no /api
CORELLIUM_API_TOKEN=••••••••                                # Settings → API Token
CORELLIUM_INSECURE_TLS=0                                    # set 1 only for self-signed on-prem
```

`.env` is git-ignored. The token is never committed, never logged, and never enters the sandbox.

---

## Use with Claude Code

```bash
claude mcp add corellium -- npx -y tsx /absolute/path/to/corellium-mcp/src/server.ts
```

Then, in a session, the model has exactly two tools — `corellium_search` and `corellium_run` —
and the full platform behind them. Ask it to *"boot an iPhone 16, install this IPA, and capture
network traffic while it launches,"* and it discovers the relevant primitives, writes one
snippet, and runs it.

---

## The quality evaluator

A code-mode MCP is only worth building if it measurably helps models. This repo ships a
**reproducible A/B harness** that quantifies the win instead of asserting it.

```
TASK SUITE ──▶ RUNNER ─┬─▶ [ code-mode MCP ]  (search + run)   ─┐
 (claims,     per model └─▶ [ naïve MCP ]      (206 tools)      ─┤  shared
  oracle ops)                                                    ▼  recorded backend (replay)
                          SCORERS ──▶ REPORT (md + json) ──  A/B + leaderboard + charts
                          tokens · tool-pick · claims · cost
```

- **A/B by construction.** The same task suite runs against this server *and* an
  auto-generated naïve server that exposes all 206 operations as individual tools — over an
  identical, **recorded** backend, so the comparison isolates the code-mode effect and runs
  deterministically and for free.
- **Metrics that matter:**
  - **Token efficiency** — always-on tool-definition tokens (`S`), per-turn growth, tool-result
    tokens (`r`), and **total tokens per completed task** (exposing the quadratic context growth
    code-mode attacks).
  - **Tool-pick accuracy** — did the model invoke the *right* Corellium operations? Measured
    identically in both modes (tool-call log vs. AST of the generated code).
  - **Task success** — claims-based scoring with partial credit, plus a failure taxonomy
    (cognitive vs. execution vs. tool-pick).
  - **Cost & latency** — tokens × rate, and p50/p95 wall-clock, per model.
- **Multi-model** — Opus / Sonnet / Haiku via the Anthropic Messages API (ground-truth token
  `usage`), with an OpenAI-compatible adapter for cross-vendor runs.

```bash
npm run eval        # → eval/reports/<timestamp>.{md,json}
```

---

## Architectural decisions

Every non-obvious choice, with the reasoning and the tradeoff.

**1. Two tools (`search` + `run`), not 206.**
The single execution primitive *is* the thesis; `search` is the cheap discovery companion that
keeps the catalog out of always-on context. *Tradeoff:* the model must discover before acting —
mitigated by ranking, detail levels, and curated recipes.

**2. Breadth from the OpenAPI spec, ergonomics from hand-written wrappers.**
The official JS SDK has **no generic `request()`**, so it can't reach 100% of the surface. We
generate a typed client from the tenant's pinned `openapi.json` (every endpoint reachable via
`corellium.request`), and add ~15 wrappers for the awkward async flows (create-and-boot with
state polling, agent sessions, capture-to-artifact). *Tradeoff:* a pinned spec can drift —
`npm run spec:pull` re-pins it in one command.

**3. TypeScript / Node, with the sandbox language being JavaScript.**
LLMs write JS far better than they emit tool-call JSON; types are terser than OpenAPI; and the
strongest in-process sandbox (`isolated-vm`, a real V8 isolate) is native to Node. One language
spans server + evaluator. *Tradeoff:* `isolated-vm` is a native addon — installs from a prebuilt
binary on common platforms.

**4. `isolated-vm`, not `vm2`/`node:vm`/containers.**
We run model-generated code beside a live credential, so we need a true heap/CPU boundary with
no Node globals, no network, no fs — not the escapable `node:vm`, and not a multi-hundred-ms
container per call. `isolated-vm` starts in milliseconds and gives exactly that. *Tradeoff:* the
sandbox is JS-only and only reaches the host through the typed bridge (by design).

**5. Token on the host, bridge in between.**
The in-sandbox `corellium` object is a thin proxy; every call crosses an `isolated-vm` Reference
to the host, which attaches the `Authorization` header — Cloudflare's `globalOutbound` idea,
realized in-process. The model can never read, log, or exfiltrate the token.

**6. Binary and large results become handles.**
Screenshots, pcaps, and dumps are written to disk and returned as small handles; JSON results
are size-capped with a "filter in-sandbox and return less" nudge. This directly minimizes the
tool-result token term that dominates multi-turn agent cost.

**7. Destructive operations are opt-in.**
Default-safe posture: `DELETE`/`erase`/`wipe`/`reset` are gated behind `allow_destructive` so an
exploratory agent cannot tear down devices, snapshots, or users by accident.

**8. The evaluator is a first-class deliverable, not an afterthought.**
The whole premise — "fewer tools, more code, better outcomes" — is an empirical claim, so the
repo ships the A/B harness that tests it against a naïve baseline over a recorded backend.

---

## Project structure

```
corellium-mcp/
├── src/
│   ├── server.ts                 # MCP server: registers corellium_search + corellium_run (stdio)
│   ├── tools/                    # search.ts (discovery) · run.ts (execution)
│   ├── primitives/
│   │   ├── client.ts             # host HTTP client — the ONLY place the token is used
│   │   ├── schema.d.ts           # types generated from openapi.json (operationId-keyed)
│   │   └── wrappers.ts           # ~15 ergonomic flows (create-and-boot, agent, capture)
│   ├── sandbox/
│   │   ├── isolate.ts            # isolated-vm executor + host bridge + guardrail
│   │   ├── preamble.ts           # in-isolate `corellium`/`console`/`sleep` definitions
│   │   └── artifacts.ts          # blob → on-disk handle store
│   └── spec/openapi.json         # pinned Corellium OpenAPI 3.0.3 (206 ops)
├── eval/                         # A/B harness: runner · scorers · tasks · naïve baseline · report
└── scripts/                      # pull-spec · smoke · sandbox-smoke
```

---

## Status & roadmap

Built and verified against a live Enterprise tenant, phase by phase:

- [x] **P0 — Scaffold + pinned spec.** Host client with Bearer auth + raw `request`; live smoke
  test lists real projects/instances; types generated from the 206-op spec.
- [x] **P1 — Sandbox + bridge.** `isolated-vm` executor, token isolation (probe-verified),
  artifact capture, destructive guardrail.
- [ ] **P2 — Primitives + wrappers.** Per-tag namespaces + the ~15 ergonomic async wrappers.
- [ ] **P3 — Discovery.** `corellium_search` with detail levels and hybrid ranking over
  spec + wrappers + recipes.
- [ ] **P4 — Evaluator.** Record/replay backend, claims-based task suite, naïve baseline,
  scorers, report.
- [ ] **P5 — Register + tune.** Wire into Claude Code; iterate on the typed surface against
  eval numbers.

---

## Prior art & references

- Anthropic — [Code execution with MCP: building more efficient agents](https://www.anthropic.com/engineering/code-execution-with-mcp) (Nov 2025)
- Cloudflare — [Code Mode: give agents an entire API in 1,000 tokens](https://blog.cloudflare.com/code-mode-mcp/) (Feb 2026)
- [Model Context Protocol specification](https://modelcontextprotocol.io)
- [Corellium REST API & SDK docs](https://support.corellium.com/sdk/)
- [`isolated-vm`](https://github.com/laverdet/isolated-vm) · [`openapi-typescript`](https://github.com/openapi-ts/openapi-typescript)

---

## License

[MIT](./LICENSE). Not affiliated with or endorsed by Corellium. Use only against devices and
tenants you are authorized to access.
