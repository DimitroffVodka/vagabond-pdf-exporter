# VCE snapshot regeneration

The three JSON files in `../data/vce/` are snapshots of the Vagabond Character
Enhancer module's compendium content (perks, classes, ancestries). The OBR
extension fetches them at import time to hydrate descriptions and decompose
ancestry/class pseudo-abilities into per-trait / per-level-feature entries.

## When to regenerate

Whenever VCE's compendium changes — new perks, new classes, updated ancestry
traits, etc.

## How to regenerate (no Foundry shutdown required)

1. Open your Foundry world with VCE active
2. Create a new Macro (Script type), paste the code below, execute
3. Three files download to your browser's downloads folder:
   `vce-perks.json`, `vce-classes.json`, `vce-ancestries.json`
4. Rename them by dropping the `vce-` prefix (`perks.json` / `classes.json` /
   `ancestries.json`) and drop them into `../data/vce/`
5. Commit + push — the next import in OBR fetches fresh content (24h cache TTL)

```js
const packs = [
  "vagabond-character-enhancer.vce-perks",
  "vagabond-character-enhancer.vce-classes",
  "vagabond-character-enhancer.vce-ancestries",
];
for (const id of packs) {
  const pack = game.packs.get(id);
  const docs = await pack.getDocuments();
  const data = docs.map(d => d.toObject());
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = id.split(".").pop() + ".json";
  a.click();
}
ui.notifications.info("Dumped VCE packs to your downloads folder");
```
