---
title: Inventory devices and filter in-sandbox (read-only)
tags: instances, list, inventory, filter, jailbreak, report, read-only
when: Use for read-only questions about which devices exist, their state, OS, or jailbreak status. Filter inside the sandbox and return only the distilled answer.
---

Do the filtering/aggregation inside `corellium_run` so a large fleet never flows
through the model's context — return only the summary.

```js
async () => {
  const projects = await corellium.projects.list();
  const rows = [];
  for (const p of projects) {
    const instances = await corellium.instances.list(p.id);
    for (const i of instances) {
      rows.push({
        project: p.name,
        name: i.name,
        flavor: i.flavor,
        os: i.os,
        state: i.state,
        // patches often encodes jailbreak posture (e.g. 'jailbroken'|'nonjailbroken')
        patches: i.patches,
      });
    }
  }
  const jailbroken = rows.filter(r => String(r.patches).includes("jailbroken") && !String(r.patches).includes("non"));
  return {
    total: rows.length,
    on: rows.filter(r => r.state === "on").length,
    jailbroken: jailbroken.map(r => r.name),
    devices: rows.slice(0, 25),   // cap; ask again if you need more
  };
}
```
