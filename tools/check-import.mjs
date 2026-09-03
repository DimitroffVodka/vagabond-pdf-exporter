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

const payload = await get(BASE);
const native = payload.character;
assert.ok(native?.name, "native response has no name");
assert.ok(native?.assignedStats, "native response has no assignedStats");
assert.ok(Number.isFinite(payload.derived?.hp?.max), "native response has no derived HP max");
assert.ok(Number.isFinite(payload.derived?.mana?.max), "native response has no derived mana max");
assert.ok(Number.isFinite(payload.derived?.castingMax), "native response has no derived casting max");

// The signed-in import path reads this Firestore route instead of the public
// endpoint, so private characters work. Can't exercise it without credentials,
// but 403 (not 404) proves the collection is there and permission-gated —
// a 404 would mean the path moved and the fallback silently took over.
const FS_BASE =
  "https://firestore.googleapis.com/v1/projects/vagabond-tag-along/databases/(default)/documents";
const fs = await fetch(`${FS_BASE}/characters/${ID}`);
assert.equal(
  fs.status, 403,
  `Firestore characters/{id} -> HTTP ${fs.status}, expected 403 PERMISSION_DENIED`
);

// Public homebrew UUIDs can be resolved without a session; private ones use
// the same route with the Firebase bearer token already held by app.js.
const monk = await get(`${FS_BASE}/homebrew_content/6eb16501-c49c-42b6-91de-dc700049791b`);
assert.equal(
  monk.fields?.data?.mapValue?.fields?.name?.stringValue,
  "Monk",
  "public homebrew name did not resolve"
);

// VCE snapshots are the same-origin fallback when Alyx's bundle is unreachable.
for (const kind of ["perks", "classes", "ancestries"]) {
  const arr = JSON.parse(await readFile(new URL(`../data/vce/${kind}.json`, import.meta.url)));
  assert.ok(Array.isArray(arr) && arr.length, `data/vce/${kind}.json is empty`);
  assert.ok(arr.every(d => d?.name), `data/vce/${kind}.json has unnamed entries`);
}

console.log(`ok — native+derived import and public homebrew resolution work for "${native.name}"`);
