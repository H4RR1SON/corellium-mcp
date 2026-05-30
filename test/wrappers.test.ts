/**
 * P2 verification (no live device needed): drives the ergonomic wrappers through
 * the REAL isolated-vm sandbox + bridge, with the host HTTP layer mocked. Proves:
 *   - binary responses (screenshot) come back as artifact HANDLES, not bytes
 *   - wrappers compose the correct verbatim spec paths
 *   - createAndBoot polls instance state
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RequestOptions, RawResponse } from "../src/primitives/client.js";

const calls: RequestOptions[] = [];

// Mock the host client so no network happens; record every request the bridge makes.
vi.mock("../src/primitives/client.js", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  return {
    redact: (s: string) => s,
    request: vi.fn(async (opts: RequestOptions): Promise<RawResponse> => {
      calls.push(opts);
      const path = opts.path;
      const method = opts.method ?? "GET";
      if (path.endsWith("/screenshot.png")) {
        return { status: 200, ok: true, headers: { "content-type": "image/png" }, bytes: PNG };
      }
      if (path === "/v1/instances" && method === "POST") {
        return { status: 200, ok: true, headers: {}, json: { id: "inst-123", state: "creating" } };
      }
      if (path === "/v1/instances/inst-123") {
        return { status: 200, ok: true, headers: {}, json: { id: "inst-123", name: "test", state: "on" } };
      }
      if (path.endsWith("/agent/v1/app/ready")) {
        return { status: 200, ok: true, headers: {}, json: { ready: true } };
      }
      if (path.endsWith("/agent/v1/app/apps") && method === "GET") {
        return { status: 200, ok: true, headers: {}, json: [{ bundleID: "com.x", name: "X" }] };
      }
      return { status: 200, ok: true, headers: {}, json: { ok: true } };
    }),
  };
});

// Import AFTER the mock is registered.
const { runCode } = await import("../src/sandbox/isolate.js");

beforeEach(() => {
  calls.length = 0;
});

describe("ergonomic wrappers over the sandbox bridge", () => {
  it("screenshot returns an artifact handle, not raw bytes", async () => {
    const r = await runCode({
      code: `async () => { const shot = await corellium.instance('inst-123').screenshot(); return shot; }`,
    });
    expect(r.ok).toBe(true);
    const handle = r.result as Record<string, unknown>;
    expect(handle.kind).toBe("image/png");
    expect(handle.path).toMatch(/^artifacts\//);
    expect(handle.bytes).toBe(12);
    expect(typeof handle.sha256).toBe("string");
    // The PNG must be tracked as an artifact and NOT inlined into the result.
    expect(r.artifacts.length).toBe(1);
    expect(JSON.stringify(r.result)).not.toMatch(/[\x89]PNG/);
    // Exact spec path was hit.
    expect(calls.some((c) => c.path === "/v1/instances/inst-123/screenshot.png")).toBe(true);
  });

  it("createAndBoot creates then polls state to 'on'", async () => {
    const r = await runCode({
      code: `async () => {
        const dev = await corellium.instances.createAndBoot({ flavor: 'iphone16pro', project: 'p1', os: '18.0' });
        const info = await dev.get();
        return { id: dev.id, state: info.state };
      }`,
    });
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ id: "inst-123", state: "on" });
    const post = calls.find((c) => c.path === "/v1/instances" && c.method === "POST");
    expect(post?.body).toMatchObject({ flavor: "iphone16pro", project: "p1", os: "18.0" });
  });

  it("agent session reaches ready then composes app paths", async () => {
    const r = await runCode({
      code: `async () => {
        const agent = await corellium.instance('inst-123').agent();
        const apps = await agent.appList();
        await agent.runApp('com.x');
        return apps;
      }`,
    });
    expect(r.ok).toBe(true);
    expect(r.result).toEqual([{ bundleID: "com.x", name: "X" }]);
    expect(calls.some((c) => c.path === "/v1/instances/inst-123/agent/v1/app/ready")).toBe(true);
    expect(calls.some((c) => c.path === "/v1/instances/inst-123/agent/v1/app/apps/com.x/run" && c.method === "POST")).toBe(true);
  });

  it("destructive wrapper (destroy) is blocked without allow_destructive", async () => {
    const r = await runCode({
      code: `async () => { await corellium.instance('inst-123').destroy(); return 'reached'; }`,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/BLOCKED/);
  });
});
