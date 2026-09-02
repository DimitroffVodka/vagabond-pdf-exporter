// Regression check for the URL/ID import path.
//
// The import broke three times now because a public CORS proxy died under it.
// It no longer uses one: vgbnd.app serves Access-Control-Allow-Origin: *, so
// the browser fetches it directly. This asserts that contract still holds —
// if vgbnd.app ever drops the header, import breaks again and this fails first.
//
//   node tools/check-import.mjs [character-id]

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ID = process.argv[2] || "b37d4b92-9885-4a3c-a864-1d856ff5ca34";
const ORIGIN = "https://dimitroffvodka.github.io";
const BASE = "https://www.vgbnd.app/api/characters/" + ID;

async function get(url) {
  const res = await fetch(url, { headers: { Origin: ORIGIN } });
  assert.equal(res.status, 200, `${url} -> HTTP ${res.status}`);
  const acao = res.headers.get("access-control-allow-origin");
  assert.ok(
    acao === "*" || acao === ORIGIN,
    `${url} -> no CORS header for ${ORIGIN} (got ${acao}); a proxy would be needed again`
  );
  return res.json();
}

// Preflight: the browser sends OPTIONS before a cross-origin GET.
const pre = await fetch(BASE, {
  method: "OPTIONS",
  headers: { Origin: ORIGIN, "Access-Control-Request-Method": "GET" },
});
assert.ok(pre.status < 400, `OPTIONS preflight -> HTTP ${pre.status}`);

const native = (await get(BASE)).character;
assert.ok(native?.name, "native response has no name");
assert.ok(native?.assignedStats, "native response has no assignedStats");

// Best-effort in app.js, but assert it here so silent degradation is visible.
const foundry = await get(BASE + "?format=foundry");
assert.ok(foundry?.system, "?format=foundry response has no system block");

// VCE snapshots are the same-origin fallback when Alyx's bundle is unreachable.
for (const kind of ["perks", "classes", "ancestries"]) {
  const arr = JSON.parse(await readFile(new URL(`../data/vce/${kind}.json`, import.meta.url)));
  assert.ok(Array.isArray(arr) && arr.length, `data/vce/${kind}.json is empty`);
  assert.ok(arr.every(d => d?.name), `data/vce/${kind}.json has unnamed entries`);
}

console.log(`ok — direct CORS fetch works, "${native.name}" imported, VCE snapshots intact`);
