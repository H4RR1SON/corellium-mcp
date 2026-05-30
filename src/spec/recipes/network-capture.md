---
title: Capture network traffic (and MITM TLS) while an app runs
tags: network, netdump, pcap, mitm, ssl, tls, sslsplit, capture, traffic
when: Use when asked to inspect, capture, or man-in-the-middle a device's network traffic.
---

Enable capture, exercise the app, then download the `.pcap` as an artifact handle.
For HTTPS interception, enable `sslsplit` (TLS MITM) before launching the app.

```js
async () => {
  const id = (await corellium.instances.list())[0].id;
  const device = corellium.instance(id);

  await device.enableSslsplit();     // TLS MITM (optional; for HTTPS visibility)
  await device.startNetdump();       // begin packet capture

  const agent = await device.agent();
  await agent.runApp("com.example.app");
  await sleep(15000);                // let traffic flow

  await device.stopNetdump();
  const pcap = await device.netdumpPcap();   // -> artifact handle (.pcap on disk)
  await device.disableSslsplit();

  return { pcap: pcap.path, bytes: pcap.bytes };
}
```

The raw bytes never enter context — the model gets `{ path, bytes, sha256, kind }`
and can hand the file path to a downstream analysis step.
