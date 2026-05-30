---
title: Boot a device, install an app, launch it, screenshot
tags: instances, boot, agent, app, install, ipa, apk, screenshot
when: Use when asked to spin up a virtual device and get an app running on it.
---

Pass this as a single `corellium_run` call. `createAndBoot` polls until the device
is `on`; `agent()` waits for the on-device agent before app operations.

```js
async () => {
  const [project] = await corellium.projects.list();

  // Create + boot (poll to state='on'). Pick a flavor/os your tenant supports.
  const device = await corellium.instances.createAndBoot({
    project: project.id,
    flavor: "iphone16pro",
    os: "18.0",
    name: "demo-device",
  });

  const agent = await device.agent();          // waits for springboard / agent ready

  // installApp takes a path already on the device filesystem. Upload first if needed
  // (agent.writeFile), or use a device path you control.
  await agent.installApp("/var/tmp/app.ipa");

  const apps = await agent.appList();
  const target = apps.find(a => /example/i.test(a.bundleID || a.name));
  if (target) await agent.runApp(target.bundleID);

  const shot = await device.screenshot();        // -> artifact handle, not bytes
  return { instance: device.id, installed: apps.length, screenshot: shot.path };
}
```
