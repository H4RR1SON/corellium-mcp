/**
 * In-isolate preamble. This JS is evaluated inside the V8 isolate before the
 * model's code. It defines the `corellium` client, `sleep`, and `console` purely
 * in terms of two host bridge references (`__bridgeRef`, `__logRef`) that the host
 * sets as globals. The API token is NOT here — every privileged action crosses the
 * bridge to the host, which attaches auth.
 *
 * NOTE on isolated-vm: separate ctx.eval() calls share the global object but NOT
 * top-level lexical (const/let) bindings, so everything the user code needs is
 * attached to `globalThis` from inside an IIFE that closes over the private helpers.
 *
 * P2 extends `corellium` with per-tag namespaces and ergonomic wrappers by
 * appending to PREAMBLE_EXTENSIONS.
 */

const PREAMBLE_CORE = /* js */ `
(() => {
  const __fmt = (v) => {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch (_) { return String(v); }
  };

  // Async host call. Protocol: __bridge(op, args) -> host returns {value} | {error}.
  const __bridge = async (op, args) => {
    const raw = await __bridgeRef.apply(undefined, [JSON.stringify({ op, args })], {
      arguments: { copy: true },
      result: { copy: true, promise: true },
    });
    const out = JSON.parse(raw);
    if (out && out.error) {
      const e = new Error(out.error);
      e.corellium = true;
      throw e;
    }
    return out ? out.value : undefined;
  };
  globalThis.__bridge = __bridge;

  globalThis.console = {
    log: (...a) => __logRef.applySync(undefined, [a.map(__fmt).join(' ')], { arguments: { copy: true } }),
  };
  globalThis.console.error = globalThis.console.log;
  globalThis.console.info = globalThis.console.log;
  globalThis.console.warn = globalThis.console.log;
  globalThis.console.debug = globalThis.console.log;

  // Cooperative sleep (used by polling wrappers). Host caps the duration.
  globalThis.sleep = (ms) => __bridge('sleep', { ms });

  // The one primitive: a typed-ish client over the full Corellium REST surface.
  // .request reaches any of the 206 operations; convenience verbs wrap it.
  // For json responses returns the parsed body; for binary returns an artifact
  // handle {name,path,bytes,sha256,kind}; for text returns the string.
  const corellium = {
    request: (opts) => __bridge('request', opts),
    get: (path, query) => __bridge('request', { method: 'GET', path, query }),
    post: (path, body) => __bridge('request', { method: 'POST', path, body }),
    put: (path, body) => __bridge('request', { method: 'PUT', path, body }),
    patch: (path, body) => __bridge('request', { method: 'PATCH', path, body }),
    del: (path, query) => __bridge('request', { method: 'DELETE', path, query }),
  };
  globalThis.corellium = corellium;
})();
`;

// Filled in by P2 (namespaces + wrappers). Appended after the core.
export let PREAMBLE_EXTENSIONS = "";

export function setPreambleExtensions(js: string): void {
  PREAMBLE_EXTENSIONS = js;
}

export function buildPreamble(): string {
  return PREAMBLE_CORE + "\n" + PREAMBLE_EXTENSIONS;
}
