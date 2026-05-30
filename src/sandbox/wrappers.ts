/**
 * In-isolate ergonomic wrappers, appended to the preamble. Pure JS composed from
 * the `corellium` primitive (.request/.get/.post/...) and `sleep`. Every path here
 * is taken verbatim from the pinned OpenAPI spec (src/spec/openapi.json) — not the
 * higher-level SDK, which lacks a generic request() and omits some operations.
 *
 * These cover the awkward async flows (create-and-boot with state polling, agent
 * sessions, capture-to-artifact). The raw `corellium.request({path})` escape hatch
 * still reaches all 206 operations for anything not wrapped here.
 */
export const WRAPPERS_JS = /* js */ `
(() => {
  const c = globalThis.corellium;

  async function pollUntil(fn, opts) {
    const o = opts || {};
    const tries = o.tries || 180;
    const intervalMs = o.intervalMs || 5000;
    let last;
    for (let i = 0; i < tries; i++) {
      try { last = await fn(); if (last) return last; } catch (e) { last = e; }
      await sleep(intervalMs);
    }
    throw new Error('timed out waiting for ' + (o.label || 'condition'));
  }

  function agentHandle(id) {
    const base = '/v1/instances/' + id + '/agent/v1';
    const enc = encodeURIComponent;
    return {
      ready: () => c.get(base + '/app/ready'),
      appList: () => c.get(base + '/app/apps'),
      icons: (bundleIds) => c.get(base + '/app/icons', bundleIds ? { 'bundleID': bundleIds } : undefined),
      // Install an app already present on the device filesystem at \`path\`.
      installApp: (path) => c.post(base + '/app/install', { path }),
      runApp: (bundleId) => c.post(base + '/app/apps/' + enc(bundleId) + '/run', {}),
      killApp: (bundleId) => c.post(base + '/app/apps/' + enc(bundleId) + '/kill', {}),
      uninstallApp: (bundleId) => c.post(base + '/app/apps/' + enc(bundleId) + '/uninstall', {}),
      // File system on the device (paths like "/tmp/x"). download -> artifact handle.
      readFile: (devicePath) => c.request({ method: 'GET', path: base + '/file/device' + devicePath, responseType: 'binary' }),
      writeFile: (devicePath, content) => c.request({ method: 'PUT', path: base + '/file/device' + devicePath, body: content }),
      deleteFile: (devicePath) => c.del(base + '/file/device' + devicePath),
      tempFile: () => c.post(base + '/file/temp', {}),
      profiles: () => c.get(base + '/profile/profiles'),
      installProfile: (profile) => c.post(base + '/profile/install', profile),
      // System (Android-centric helpers that exist in this API version).
      networkInfo: () => c.get(base + '/system/network'),
      getProp: (name) => c.post(base + '/system/getprop', { name }),
      lock: () => c.post(base + '/system/lock', {}),
      unlock: () => c.post(base + '/system/unlock', {}),
      shutdown: () => c.post(base + '/system/shutdown', {}),
    };
  }

  function instanceHandle(id) {
    const ip = '/v1/instances/' + id;
    return {
      id,
      get: () => c.get(ip),
      rename: (name) => c.patch(ip, { name }),
      start: (opts) => c.post(ip + '/start', opts),
      stop: (opts) => c.post(ip + '/stop', opts),
      reboot: () => c.post(ip + '/reboot'),
      pause: () => c.post(ip + '/pause'),
      unpause: () => c.post(ip + '/unpause'),
      setState: (state) => c.put(ip + '/state', { state }),
      destroy: () => c.del(ip),                                   // gated by guardrail
      // Capture (binary) -> artifact handles, never raw bytes in context.
      screenshot: (format) => c.request({ method: 'GET', path: ip + '/screenshot.' + (format || 'png'), responseType: 'binary' }),
      consoleLog: () => c.request({ method: 'GET', path: ip + '/consoleLog', responseType: 'text' }),
      panics: () => c.get(ip + '/panics'),
      clearPanics: () => c.del(ip + '/panics'),
      peripherals: () => c.get(ip + '/peripherals'),
      setPeripherals: (data) => c.put(ip + '/peripherals', data),
      // Snapshots.
      snapshots: () => c.get(ip + '/snapshots'),
      takeSnapshot: (name) => c.post(ip + '/snapshots', { name }),
      restoreSnapshot: (snapshotId) => c.post(ip + '/snapshots/' + snapshotId + '/restore'),
      // Network capture.
      startNetdump: (filter) => c.post(ip + '/netdump/enable', filter),
      stopNetdump: () => c.post(ip + '/netdump/disable', {}),
      netdumpPcap: () => c.request({ method: 'GET', path: ip + '/netdump.pcap', responseType: 'binary' }),
      networkMonitorPcap: () => c.request({ method: 'GET', path: ip + '/networkMonitor.pcap', responseType: 'binary' }),
      enableSslsplit: (filter) => c.post(ip + '/sslsplit/enable', filter),
      disableSslsplit: () => c.post(ip + '/sslsplit/disable', {}),
      // CoreTrace (full syscall trace).
      enableCoreTrace: () => c.post(ip + '/strace/enable', {}),
      disableCoreTrace: () => c.post(ip + '/strace/disable', {}),
      coreTraceThreads: () => c.get(ip + '/strace/thread-list'),
      clearCoreTrace: () => c.del(ip + '/strace'),
      // Polling helpers.
      waitForState: (state, opts) =>
        pollUntil(async () => (await c.get(ip)).state === state, Object.assign({ label: 'state=' + state }, opts)),
      // Resolve once the on-device agent is reachable (post-boot springboard).
      agent: async (opts) => {
        await pollUntil(async () => {
          const r = await c.get(ip + '/agent/v1/app/ready');
          return r && (r.ready === true || r.ready === undefined ? r.ready : false);
        }, Object.assign({ label: 'agent ready', intervalMs: 3000, tries: 120 }, opts));
        return agentHandle(id);
      },
    };
  }

  c.instance = instanceHandle;

  c.projects = {
    list: () => c.get('/v1/projects'),
    get: (projectId) => c.get('/v1/projects/' + projectId),
    instances: (projectId) => c.get('/v1/projects/' + projectId + '/instances'),
  };

  c.instances = {
    list: (project) => c.get('/v1/instances', project ? { project } : undefined),
    get: (id) => c.get('/v1/instances/' + id),
    // opts: { flavor, project, os, name?, patches?, osbuild?, ... } (InstanceCreateOptions)
    create: (opts) => c.post('/v1/instances', opts),
    createAndBoot: async (opts) => {
      const created = await c.post('/v1/instances', opts);
      const h = instanceHandle(created.id);
      await h.waitForState('on');
      return h;
    },
    handle: instanceHandle,
  };

  c.snapshots = {
    get: (snapshotId) => c.get('/v1/snapshots/' + snapshotId),
    rename: (snapshotId, name) => c.patch('/v1/snapshots/' + snapshotId, { name }),
    del: (snapshotId) => c.del('/v1/snapshots/' + snapshotId),   // gated by guardrail
  };
})();
`;
