# vgbnd.app API map

Audited: 2026-09-02

This is a reverse-engineered compatibility note, not an official contract. `vgbnd.app` has one small public HTTP surface for individual public characters; its own client uses Firebase Authentication and Firestore directly for account data, private characters, groups, and homebrew.

## Evidence legend

- **Live-verified** — read-only request made against production on 2026-09-02.
- **Source-verified** — observed in the production client bundle or source code.
- **Maintainer claim** — stated by the third-party Foundry importer.
- **Inference** — likely behavior not safely exercised against production.

Production bundle snapshots used below:

- `28d3a35d1f805d99.js`: SHA-256 `680ae48caba3647e098406ebf071f29a70b738a704979369a62b9bcc34bfe2dd`
- `5ea6831db8fc9c31.js`: SHA-256 `a1b2c67f9950ffb2091aabbd3e63c0225bf895b1e573fd6a589a313f0ebcc2fd`
- `606e5848ee88f5c5.js`: SHA-256 `d4c78c7c16f0fbe0bb47e8e549012dadea673b3c5b5029c6b41650122188443c`
- `7345424ce2552551.js`: SHA-256 `954f8e6228acd36e353dc1d1379157617beace48f15676785231e22dab42e0c3`

The third-party Foundry importer was audited at commit [`dff3367961877daff2dc2002c2981a09e625cef4`](https://github.com/mordachai/vagabond-app-importer/tree/dff3367961877daff2dc2002c2981a09e625cef4), tagged `v2.6.0`.

## Short answer

Use these two paths:

1. **Public character URL/import:** `GET https://www.vgbnd.app/api/characters/{uuid}`.
2. **Account browser/private import:** Firebase email/password authentication followed by Firestore REST queries against the `characters` collection.

There is no list-style vgbnd REST route: `GET /api/characters` returned `404`. No OpenAPI, Swagger, `/api/docs`, or `/docs` endpoint was present.

## Public character endpoint

### Native response

```http
GET /api/characters/{uuid}
Accept: application/json
```

**Live-verified:**

- Public UUID: `200 application/json`
- Response CORS header: `Access-Control-Allow-Origin: *`
- Unknown UUID: `404 {"error":"Character not found"}`
- Collection route `/api/characters`: `404`

Successful response:

```json
{
  "character": { "...native Firestore-shaped character...": "..." },
  "derived": { "...calculated values...": "..." }
}
```

Top-level `character` fields observed on the public fixture:

- identity: `id`, `userId`, `name`, `is_public`
- progression: `level`, `xp`, `createdAt`, `updatedAt`
- build: `class`, `ancestry`, `statArray`, `assignedStats`, `levelStats`, `strongPotentialStat`
- resources: `current_hp`, `current_mana`, `current_luck`, `current_wealth`, `rations`
- choices: `trained_skills`, `selected_perks`, `known_spells`, `mandatory_spell_overrides`, `ancestry_bonus_spell`
- possessions/content: `inventory`, `mounts`, `notes`, `active_statuses`
- portrait metadata: `portrait_crop`

Observed nested shapes:

```text
assignedStats  { might, dexterity, awareness, reason, presence, luck }
levelStats     partial map of the same six stats
current_wealth { g, s, c }
selected_perks [{ id, name, prereqs, source }]
known_spells   [string]
trained_skills [string]
portrait_crop  { x, y, scale }
notes          [{ id, title, body, dateCreated }]
mounts         [{ id, name, inventory, baseCapacity, canSaddle, isActive }]
```

Inventory entries are heterogeneous. The union of keys observed was:

```text
id, name, computedName, type, category, quantity, count, slots, totalSlots,
capacity, value, notes, desc, damage, grip, range, rating, might_req,
properties, material, relic_powers, can_equip, is_equipped, isEquipped,
is_cursed, is_custom, is_custom_name, indices, displayValue
```

The `derived` object contained:

```text
stats, skills, saves, hp, mana, armor, speed, attacks, castingMax,
maxKnownSpells
```

Notable shapes:

```text
hp      { current, max }
mana    { current, max }
speed   { val, crawl, travel }
saves   { endure, reflex, will }
attacks [{ name, stat, val }]
skills  [{ name, stat, trained, val }]
```

### Foundry response

```http
GET /api/characters/{uuid}?format=foundry
Accept: application/json
```

**Live-verified** successful response:

```json
{
  "name": "...",
  "type": "character",
  "items": [],
  "system": {}
}
```

The response's top-level keys were exactly `items`, `name`, `system`, and `type`; it did **not** include the vgbnd UUID. Preserve the UUID from the request if stable re-import identity matters.

Observed item types: `ancestry`, `class`, `equipment`, and `perk`. The live fixture had no spell item despite having three entries in native `known_spells`, so consumers should not assume this transform includes every native field.

Observed `system` keys:

```text
attributes, currency, currentLuck, fatigue, health, mana, saves, skills,
speed, stats
```

Important nested keys:

```text
attributes { level, xp }
currency   { gold, silver, copper }
health     { value, max, bonus }
mana       { current, max, bonus, castingMax, castingMaxBonus }
```

### Privacy behavior

The public route is used as a fallback by the Foundry importer and is described there as public-only ([`browser-dialog.mjs#L275-L303`](https://github.com/mordachai/vagabond-app-importer/blob/dff3367961877daff2dc2002c2981a09e625cef4/scripts/browser-dialog.mjs#L275-L303)). A private-character response was not tested because that would require a real private UUID. Treat `403` for private characters as an implementation expectation, not a live-verified contract.

The importer's comment that this route is blocked by browser CORS is stale: production returned `Access-Control-Allow-Origin: *` during this audit.

## Firebase Authentication

The production client is a normal Firebase web client. The Firebase client API key is intentionally present in shipped JavaScript; it identifies the Firebase project but is not an authorization secret. This document does not duplicate it—reuse the existing `FIREBASE_API_KEY` constant in `app.js`.

### Email/password sign-in

```http
POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={FIREBASE_API_KEY}
Content-Type: application/json

{
  "email": "...",
  "password": "...",
  "returnSecureToken": true
}
```

Useful response fields:

```text
idToken, refreshToken, localId, email, displayName, expiresIn
```

`localId` is the Firebase UID. Send `idToken` as `Authorization: Bearer {idToken}` to Firestore. The flow is source-verified in the independent importer ([`firebase.mjs#L28-L43`](https://github.com/mordachai/vagabond-app-importer/blob/dff3367961877daff2dc2002c2981a09e625cef4/scripts/firebase.mjs#L28-L43)) and already implemented in this exporter at `app.js:733-756`.

### Refresh

```http
POST https://securetoken.googleapis.com/v1/token?key={FIREBASE_API_KEY}
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&refresh_token={URL_ENCODED_REFRESH_TOKEN}
```

Useful response fields: `id_token`, `refresh_token`, and `expires_in`. Source: [`firebase.mjs#L52-L75`](https://github.com/mordachai/vagabond-app-importer/blob/dff3367961877daff2dc2002c2981a09e625cef4/scripts/firebase.mjs#L52-L75); local implementation: `app.js:769-799`.

### Guest mode

**Source-verified:** “Continue as Guest” is Firebase anonymous authentication with `browserLocalPersistence`, not a separate vgbnd session API. See the formatted production bundle snapshot at:

```text
/home/patricks/.hermes/cache/browser-use/workspace/20260902_181314_f7503c/5ea6831db8fc9c31.pretty.js:274-323
```

The production UI calls Firebase SDK `signInAnonymously()` and receives a normal Firebase user. Guest write behavior was not tested.

## Firestore REST

Base URL:

```text
https://firestore.googleapis.com/v1/projects/vagabond-tag-along/databases/(default)/documents
```

All private/account requests use:

```http
Authorization: Bearer {FIREBASE_ID_TOKEN}
```

### List the signed-in user's characters

```http
POST {FS_BASE}:runQuery
Content-Type: application/json
Authorization: Bearer {idToken}

{
  "structuredQuery": {
    "from": [{ "collectionId": "characters" }],
    "where": {
      "fieldFilter": {
        "field": { "fieldPath": "userId" },
        "op": "EQUAL",
        "value": { "stringValue": "{uid}" }
      }
    }
  }
}
```

Firestore returns an array of rows; successful rows contain `document.name`, `document.updateTime`, and typed `document.fields`. Source: [`firebase.mjs#L78-L91`](https://github.com/mordachai/vagabond-app-importer/blob/dff3367961877daff2dc2002c2981a09e625cef4/scripts/firebase.mjs#L78-L91) and [`firebase.mjs#L143-L160`](https://github.com/mordachai/vagabond-app-importer/blob/dff3367961877daff2dc2002c2981a09e625cef4/scripts/firebase.mjs#L143-L160). Local implementation: `app.js:801-829`.

### Read one character, including a private owned character

```http
GET {FS_BASE}/characters/{uuid}
Authorization: Bearer {idToken}
```

Response fields use Firestore's typed-value JSON representation. Source: [`firebase.mjs#L94-L102`](https://github.com/mordachai/vagabond-app-importer/blob/dff3367961877daff2dc2002c2981a09e625cef4/scripts/firebase.mjs#L94-L102). Local implementation: `app.js:831-842`.

### Patch selected fields on an existing character

```http
PATCH {FS_BASE}/characters/{uuid}?updateMask.fieldPaths=current_hp&updateMask.fieldPaths=current_mana
Content-Type: application/json
Authorization: Bearer {idToken}

{
  "fields": {
    "current_hp": { "integerValue": "7" },
    "current_mana": { "integerValue": "3" }
  }
}
```

Only include fields named by the update mask. The third-party importer patches existing owned characters this way ([`firebase.mjs#L119-L129`](https://github.com/mordachai/vagabond-app-importer/blob/dff3367961877daff2dc2002c2981a09e625cef4/scripts/firebase.mjs#L119-L129)). Its synced field set is `level`, `xp`, `current_hp`, `current_mana`, `current_luck`, `assignedStats`, `current_wealth`, `known_spells`, `inventory`, `selected_perks`, and `trained_skills` ([`sync.mjs#L38-L89`](https://github.com/mordachai/vagabond-app-importer/blob/dff3367961877daff2dc2002c2981a09e625cef4/scripts/sync.mjs#L38-L89)).

No write was performed during this audit. Firestore security rules remain the real authorization boundary.

## Firestore typed values

Minimal decoder already used by this exporter:

```text
stringValue    -> string
integerValue   -> Number(...)
doubleValue    -> number
booleanValue   -> boolean
nullValue      -> null
timestampValue -> timestamp string
arrayValue     -> recursively decoded arrayValue.values
mapValue       -> recursively decoded mapValue.fields
```

See `app.js:702-715`.

## Custom/homebrew UUID resolution

Older exporter revisions said there was no API to resolve custom-content UUIDs. The importer now uses the Firestore route below.

**Source-verified production behavior:** the client resolves a custom ID from its loaded homebrew items first, matching either `id` or `originalId` and the requested type. If it is still unresolved, it reads:

```http
GET {FS_BASE}/homebrew_content/{uuid}
Authorization: Bearer {idToken}
```

and uses:

```text
document.fields.data.mapValue.fields.name
```

The production resolver is visible in:

```text
/home/patricks/.hermes/cache/browser-use/workspace/20260902_181314_f7503c/5ea6831db8fc9c31.pretty.js:517-560
```

The homebrew provider queries `homebrew_content` by `userId == auth.uid`. Observed document metadata includes:

```text
type, data, userId, isPublic, isOfficial, version, source, originalId,
collection, collection_desc, metrics, author, authorUsername, dateCreated,
lastModified, createdAt, updatedAt
```

Evidence:

```text
/home/patricks/.hermes/cache/browser-use/workspace/20260902_181314_f7503c/28d3.pretty.js:123-192
```

This gives the exporter a better path than growing `NAME_ALIASES`: public homebrew documents resolve without a session, while authenticated imports can also read private owned content. The alias table remains a fallback when a document is unavailable.

## Other observed collections

These are Firestore collections used directly by the production client, not documented REST resources:

```text
characters
users
groups
group_invites
homebrew_content
homebrew_likes
```

Verified query patterns include:

```text
characters: userId == uid
characters: userId == uid AND is_public == true
groups:     members ARRAY_CONTAINS uid
homebrew_content: userId == uid
```

The production client creates characters as `characters/{crypto.randomUUID()}` with `id`, `userId`, `createdAt`, `updatedAt`, and initial current resources. Evidence:

```text
/home/patricks/.hermes/cache/browser-use/workspace/20260902_181314_f7503c/606e5848ee88f5c5.pretty.js:60-106
```

Creation was not exercised in this audit.

## Other Next.js API routes found

The only additional application-server routes found in the downloaded client bundles were authenticated Atlas relay routes:

```text
POST /api/atlas/launch   { groupId }
POST /api/atlas/voucher  { groupId }
POST /api/atlas/present  { groupId, roll }
```

They send the current Firebase ID token as a bearer token. These are unrelated to PDF/character import and should not be coupled into this exporter. Evidence:

```text
/home/patricks/.hermes/cache/browser-use/workspace/20260902_181314_f7503c/5ea6831db8fc9c31.pretty.js:562-605
```

## Current exporter assessment

The current implementation now uses the discovered contracts directly:

- email/password Firebase sign-in: `app.js:732-755`
- token refresh: `app.js:768-798`
- list owned characters with `runQuery`: `app.js:800-828`
- direct authenticated character read: `app.js:834-841`
- custom-content name resolution through `homebrew_content/{uuid}`
- public API fallback preserving the native `derived` block
- native-to-OBR mapping accepting native and Foundry-derived shapes

Remaining gaps:

1. **Account browser covers owned characters only.** Groups and their member-character slots are available through Firestore, but are not needed for the current PDF-export use case.
2. **Private derived maxima remain best-effort.** Private documents are readable through authenticated Firestore, but the public endpoint cannot necessarily provide their computed maxima. The mapper retains its existing fallbacks.
3. **Private status is intentionally opaque.** The public endpoint may collapse private and missing records into `403`/`404`; the authenticated Firestore path is the reliable private-character path.
4. **The API is unversioned.** Keep shape validation and clear errors at the importer boundary because production fields can drift without notice.

## Implemented importer path

Unresolved UUID-like class, ancestry, and perk values now follow:

```text
characters/{uuid} -> inspect custom IDs -> homebrew_content/{customId} -> data.name
```

`NAME_ALIASES` remains a fallback for unavailable documents. Group support and write-back remain out of scope until needed.
