
import OBR from "./vendor/obr-sdk.js";

    const METADATA_KEY = "vagabond.character.extension/metadata";
    let characters = [];
    let selectedId = null;

    // --- Compendium lookup (fetches Alyx's OBR Vagabond extension bundle) ---

    // Bump CACHE_VERSION whenever the parser schema changes so old caches
    // don't linger on upgraded clients.
    const COMPENDIUM_CACHE_VERSION = 4;
    const COMPENDIUM_CACHE_KEY = "vagabond-pdf-exporter:compendium-cache:v" + COMPENDIUM_CACHE_VERSION;
    const COMPENDIUM_TTL_MS = 24 * 60 * 60 * 1000;
    const COMPENDIUM_HOST = "https://vagabond-extension.onrender.com";
    let compendiumPromise = null;

    function parseCompendiumEntry(s, start) {
      let depth = 0, inStr = false, escape = false;
      for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (escape) { escape = false; continue; }
        if (c === "\\") { escape = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) return s.slice(start, i + 1); }
      }
      return null;
    }

    // Unescape a raw JS string body (minus the outer quotes). Works for both
    // double-quoted strings and template literals with no ${} interpolations.
    function unescapeJsString(raw) {
      return raw.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, c) => {
        if (c[0] === "u") return String.fromCharCode(parseInt(c.slice(1), 16));
        if (c[0] === "x") return String.fromCharCode(parseInt(c.slice(1), 16));
        if (c === "n") return "\n";
        if (c === "t") return "\t";
        if (c === "r") return "\r";
        if (c === "b") return "\b";
        if (c === "f") return "\f";
        if (c === "0") return "\0";
        return c; // \\ \" \` \' and any literal character
      });
    }

    // Match description:"..." OR description:`...` — the bundle uses both.
    // Template-literal description with ${} interpolation would be rare for
    // static text; those would not match and just be skipped.
    const DESC_DOUBLE_RE = /[,{]description:"((?:[^"\\]|\\.)*)"/;
    const DESC_BACKTICK_RE = /[,{]description:`((?:[^`\\]|\\.)*)`/;

    function extractDescription(entry) {
      const dq = DESC_DOUBLE_RE.exec(entry);
      if (dq) return unescapeJsString(dq[1]);
      const bt = DESC_BACKTICK_RE.exec(entry);
      if (bt) return unescapeJsString(bt[1]);
      return null;
    }

    function parseCompendium(js) {
      // Two pools because the bundle uses two entry shapes:
      //   byName: {name:"...", description:...}       (perks, ancestry traits, class features, bestiary)
      //   byItem: {id:N, item:"...", ..., description:...}  (spells, gear, weapons, alchemicals)
      const byName = {};
      const byItem = {};

      for (let i = 0; i < js.length - 10; i++) {
        if (js[i] !== "{") continue;

        // Three known shapes:
        //   {name:"..."}              -> bestiary / misc   -> byName
        //   {id:N,name:"..."}         -> perks              -> byName
        //   {id:N,item:"..."}         -> spells/gear/ancestry/class -> byItem
        let shape;
        if (js.startsWith('name:"', i + 1)) shape = "name";
        else if (/^\{id:\d+,name:"/.test(js.slice(i, i + 32))) shape = "idName";
        else if (/^\{id:\d+,item:"/.test(js.slice(i, i + 32))) shape = "idItem";
        else continue;

        const entry = parseCompendiumEntry(js, i);
        if (!entry) continue;

        let keyMatch;
        if (shape === "name") keyMatch = /^\{name:"((?:[^"\\]|\\.)*)"/.exec(entry);
        else if (shape === "idName") keyMatch = /^\{id:\d+,name:"((?:[^"\\]|\\.)*)"/.exec(entry);
        else keyMatch = /^\{id:\d+,item:"((?:[^"\\]|\\.)*)"/.exec(entry);
        if (!keyMatch) continue;

        const desc = extractDescription(entry);
        if (!desc) continue;

        let name;
        try { name = unescapeJsString(keyMatch[1]); } catch { continue; }
        if (!name) continue;

        const key = String(name).toLowerCase().trim();
        // Perks ({id,name}) and bare {name} entries share the byName pool —
        // both are things looked up by display-name (perks, features, traits).
        const pool = shape === "idItem" ? byItem : byName;
        if (!pool[key]) pool[key] = desc;
      }
      return { byName, byItem };
    }

    async function fetchCompendium() {
      // Discover current bundle hash from index.html (hash changes on rebuild)
      const proxy = u => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u);
      const indexRes = await fetch(proxy(COMPENDIUM_HOST + "/"));
      if (!indexRes.ok) throw new Error("index HTTP " + indexRes.status);
      const indexHtml = await indexRes.text();
      // codetabs (and similar proxies) sometimes return HTTP 200 with a JSON
      // error body when the upstream is unreachable or the quota is exceeded
      if (indexHtml.startsWith("{") && /"error"\s*:/.test(indexHtml)) {
        throw new Error("proxy error body: " + indexHtml.slice(0, 120));
      }
      const bundleMatch = /assets\/index-[A-Za-z0-9_-]+\.js/.exec(indexHtml);
      if (!bundleMatch) throw new Error("couldn't find bundle in index");
      const bundleUrl = COMPENDIUM_HOST + "/" + bundleMatch[0];
      const bundleRes = await fetch(proxy(bundleUrl));
      if (!bundleRes.ok) throw new Error("bundle HTTP " + bundleRes.status);
      const js = await bundleRes.text();
      if (js.length < 10000 && js.startsWith("{") && /"error"\s*:/.test(js)) {
        throw new Error("proxy error body on bundle: " + js.slice(0, 120));
      }
      const entries = parseCompendium(js);
      try {
        localStorage.setItem(COMPENDIUM_CACHE_KEY, JSON.stringify({
          bundleUrl, fetchedAt: Date.now(), entries,
        }));
      } catch {}
      return entries;
    }

    async function getCompendium() {
      if (compendiumPromise) return compendiumPromise;
      compendiumPromise = (async () => {
        try {
          const raw = localStorage.getItem(COMPENDIUM_CACHE_KEY);
          if (raw) {
            const cache = JSON.parse(raw);
            if (cache?.entries && Date.now() - cache.fetchedAt < COMPENDIUM_TTL_MS) {
              return cache.entries;
            }
          }
        } catch {}
        return await fetchCompendium();
      })();
      try {
        return await compendiumPromise;
      } catch (e) {
        compendiumPromise = null; // allow retry next import
        throw e;
      }
    }

    async function enhanceWithCompendium(char) {
      let pools;
      try {
        const hasCache = !!localStorage.getItem(COMPENDIUM_CACHE_KEY);
        if (!hasCache) setStatus("Fetching compendium (first time)...", "");
        pools = await getCompendium();
      } catch (e) {
        console.warn("Compendium lookup unavailable:", e.message);
        return char;
      }
      const byName = pools.byName || {};
      const byItem = pools.byItem || {};
      const lookup = (name, preferItem) => {
        if (!name) return "";
        const key = String(name).toLowerCase().trim();
        if (preferItem) return byItem[key] || byName[key] || "";
        return byName[key] || byItem[key] || "";
      };
      // Abilities are perks / class features / ancestry traits -> byName pool
      for (const id in (char.abilities || {})) {
        const ab = char.abilities[id];
        if (!ab.description) {
          const hit = lookup(ab.name, false);
          if (hit) ab.description = hit;
        }
      }
      // Spells live in the byItem pool ({id,item,...,description})
      for (const id in (char.spells || {})) {
        const sp = char.spells[id];
        if (!sp.description) {
          const hit = lookup(sp.name, true);
          if (hit) sp.description = hit;
        }
      }
      return char;
    }

    OBR.onReady(async () => {
      await loadCharacters();
      OBR.scene.onMetadataChange(() => loadCharacters());
    });

    async function loadCharacters() {
      try {
        const metadata = await OBR.scene.getMetadata();
        const charData = metadata[METADATA_KEY];
        if (!charData || Object.keys(charData).length === 0) {
          characters = [];
          renderList();
          setStatus("No characters found in this scene. Create one in the Vagabond extension first.", "error");
          return;
        }
        characters = Object.values(charData);
        if (characters.length === 1 && !selectedId) {
          selectedId = characters[0].id;
        }
        renderList();
        setStatus(characters.length + " character" + (characters.length !== 1 ? "s" : "") + " found", "success");
      } catch (e) {
        setStatus("Error reading scene data: " + e.message, "error");
      }
    }

    function setStatus(msg, type = "") {
      const el = document.getElementById("status");
      el.textContent = msg;
      el.className = type;
    }

    function esc(str) {
      const d = document.createElement("div");
      d.textContent = str;
      return d.innerHTML;
    }

    function statBadge(label, val) {
      return '<div class="stat-badge"><span class="label">' + label + '</span> <span class="val">' + (val ?? 0) + '</span></div>';
    }

    function renderList() {
      const list = document.getElementById("charList");
      list.innerHTML = "";

      if (characters.length === 0) {
        list.innerHTML = '<div class="empty-state">No characters in scene</div>';
        document.getElementById("exportBtn").disabled = true;
        document.getElementById("exportFoundryBtn").disabled = true;
        return;
      }

      for (const char of characters) {
        const card = document.createElement("div");
        card.className = "char-card" + (char.id === selectedId ? " selected" : "");
        card.onclick = () => { selectedId = char.id; renderList(); };

        const s = char.stats || {};
        const info = [char.class, char.ancestry, char.level ? "Lv " + char.level : ""]
          .filter(Boolean).join(" \u00B7 ");

        card.innerHTML =
          '<div class="name">' + esc(char.name || "Unnamed") + '</div>' +
          '<div class="info">' + esc(info) + '</div>' +
          '<div class="stats-row">' +
            statBadge("MIT", s.might) + statBadge("DEX", s.dexterity) +
            statBadge("AWR", s.awareness) + statBadge("RSN", s.reason) +
            statBadge("PRS", s.presence) + statBadge("LUK", s.luck) +
          '</div>';
        list.appendChild(card);
      }

      document.getElementById("exportBtn").disabled = !selectedId;
      document.getElementById("exportFoundryBtn").disabled = !selectedId;
    }

    // --- Foundry JSON import ---

    function uid() {
      if (crypto && crypto.randomUUID) return crypto.randomUUID();
      return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    }

    function stripHtml(html) {
      if (!html) return "";
      const d = document.createElement("div");
      d.innerHTML = String(html);
      return d.textContent.replace(/\s+/g, " ").trim();
    }

    function mapSize(s) {
      const map = { tiny: "T", small: "S", medium: "M", large: "L", huge: "H", gargantuan: "G" };
      return map[String(s || "").toLowerCase()] || "M";
    }

    function mapFoundryToVagabond(foundry) {
      const sys = foundry.system || {};
      const items = foundry.items || [];
      const ancestryItem = items.find(i => i.type === "ancestry");
      const classItem = items.find(i => i.type === "class");
      const perks = items.filter(i => i.type === "perk");
      const equipment = items.filter(i => i.type === "equipment");
      const spellItems = items.filter(i => i.type === "spell");

      const stat = k => sys.stats?.[k]?.value ?? 0;
      const stats = {
        might: stat("might"),
        dexterity: stat("dexterity"),
        awareness: stat("awareness"),
        reason: stat("reason"),
        presence: stat("presence"),
        luck: stat("luck"),
      };

      const training = {};
      const skillKeys = [
        "arcana","brawl","craft","detect","finesse","influence","leadership",
        "medicine","mysticism","performance","sneak","survival","melee","ranged",
      ];
      for (const k of skillKeys) {
        training[k] = !!(sys.skills?.[k]?.trained);
      }

      // Armor Rating: sum armorBonus changes across actor + equipped item effects
      let armor = 0;
      const addArmorFromEffects = effects => {
        for (const eff of (effects || [])) {
          if (eff.disabled) continue;
          for (const ch of (eff.changes || [])) {
            if (ch.key === "system.armorBonus") {
              armor += parseInt(ch.value, 10) || 0;
            }
          }
        }
      };
      addArmorFromEffects(foundry.effects);
      for (const item of items) {
        if (item.type === "equipment" && item.system?.equipped === false) continue;
        addArmorFromEffects(item.effects);
      }

      // Inventory — weapons keep damage, other equipment becomes gear
      const inventory = {};
      equipment
        .slice()
        .sort((a, b) => (a.sort || 0) - (b.sort || 0))
        .forEach((item, idx) => {
          const s = item.system || {};
          const isWeapon = s.equipmentType === "weapon";
          const damage = isWeapon
            ? (s.grip === "2H" ? s.damageTwoHands : s.damageOneHand) || s.damageOneHand || ""
            : "";
          const props = Array.isArray(s.properties) ? s.properties.filter(Boolean) : [];
          const description = props.length ? props.join(", ") : stripHtml(s.description);
          const qty = Number(s.quantity) || 1;
          const id = uid();
          inventory[id] = {
            id,
            item: item.name || "",
            damage,
            description,
            info: qty > 1 ? "x" + qty : "",
            grip: isWeapon ? (s.grip || "1H") : "",
            order: idx,
          };
        });

      // Abilities: ancestry traits + class features up to character level + perks
      const abilities = {};
      const charLevel = Number(sys.attributes?.level?.value) || 1;
      let order = 0;
      const addAbility = (name, desc) => {
        if (!name) return;
        const id = uid();
        abilities[id] = { id, name, description: stripHtml(desc), order: order++ };
      };
      for (const trait of (ancestryItem?.system?.traits || [])) {
        addAbility(trait.name, trait.description);
      }
      for (const f of (classItem?.system?.levelFeatures || [])) {
        if ((Number(f.level) || 1) <= charLevel) addAbility(f.name, f.description);
      }
      for (const perk of perks) {
        addAbility(perk.name, perk.system?.description);
      }

      // Spells
      const spells = {};
      spellItems
        .slice()
        .sort((a, b) => (a.sort || 0) - (b.sort || 0))
        .forEach((sp, idx) => {
          const id = uid();
          const s = sp.system || {};
          const info = [s.deliveryType, s.manaCost ? s.manaCost + " mana" : ""]
            .filter(Boolean).join(", ");
          spells[id] = {
            id,
            name: sp.name || "",
            description: stripHtml(s.description),
            info,
            order: idx,
          };
        });

      const id = uid();
      return {
        id,
        name: foundry.name || "Imported",
        level: charLevel,
        xp: Number(sys.attributes?.xp) || 0,
        ancestry: ancestryItem?.name || "",
        class: classItem?.name || "",
        speed: "",
        speedBonus: "",
        size: mapSize(sys.attributes?.size || ancestryItem?.system?.size),
        beingType: sys.attributes?.beingType || "Humanlike",
        stats,
        training,
        currentHP: sys.health?.value ?? 0,
        maxHP: sys.health?.max ?? 0,
        armor,
        currentMana: sys.mana?.current ?? 0,
        maxMana: sys.mana?.max ?? 0,
        maxCastingMana: sys.mana?.castingMax ?? 0,
        currentLuck: sys.currentLuck ?? 0,
        fatigue: sys.fatigue ?? 0,
        wealth: {
          gold: Number(sys.currency?.gold) || 0,
          silver: Number(sys.currency?.silver) || 0,
          copper: Number(sys.currency?.copper) || 0,
        },
        inventory,
        abilities,
        spells,
      };
    }

    // --- vgbnd.app direct import (Firestore REST) ---

    const FIREBASE_API_KEY = "AIzaSyAX0K_GzIlY_26QK5EMvpvBKpFbA791jT0";
    const FIREBASE_PROJECT = "vagabond-tag-along";
    const FS_BASE = "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT + "/databases/(default)/documents";
    const SESSION_KEY = "vagabond-pdf-exporter:vgbnd-session";

    function fsVal(v) {
      if ("stringValue" in v) return v.stringValue;
      if ("integerValue" in v) return Number(v.integerValue);
      if ("doubleValue" in v) return v.doubleValue;
      if ("booleanValue" in v) return v.booleanValue;
      if ("nullValue" in v) return null;
      if ("timestampValue" in v) return v.timestampValue;
      if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(fsVal);
      if ("mapValue" in v) return fsFields(v.mapValue.fields ?? {});
      return undefined;
    }
    function fsFields(fields) {
      return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, fsVal(v)]));
    }

    function loadVgbndSession() {
      try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); }
      catch { return null; }
    }
    function saveVgbndSession(s) {
      localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    }
    function clearVgbndSession() {
      localStorage.removeItem(SESSION_KEY);
    }

    async function vgbndSignIn(email, password) {
      const res = await fetch(
        "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + FIREBASE_API_KEY,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, returnSecureToken: true }),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        const msg = data.error?.message || ("HTTP " + res.status);
        throw new Error(prettyAuthError(msg));
      }
      const session = {
        idToken: data.idToken,
        refreshToken: data.refreshToken,
        uid: data.localId,
        email: data.email || email,
        expiresAt: Date.now() + Number(data.expiresIn) * 1000 - 60_000,
      };
      saveVgbndSession(session);
      return session;
    }

    function prettyAuthError(code) {
      const m = {
        EMAIL_NOT_FOUND: "No account with that email.",
        INVALID_PASSWORD: "Wrong password.",
        INVALID_LOGIN_CREDENTIALS: "Wrong email or password.",
        USER_DISABLED: "This account has been disabled.",
        TOO_MANY_ATTEMPTS_TRY_LATER: "Too many attempts — try again later.",
      };
      return m[code] || code;
    }

    async function vgbndGetSession() {
      const s = loadVgbndSession();
      if (!s) return null;
      if (Date.now() < s.expiresAt) return s;
      try {
        const res = await fetch(
          "https://securetoken.googleapis.com/v1/token?key=" + FIREBASE_API_KEY,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(s.refreshToken),
          }
        );
        const data = await res.json();
        if (!res.ok) throw new Error("HTTP " + res.status);
        const updated = {
          ...s,
          idToken: data.id_token,
          refreshToken: data.refresh_token,
          expiresAt: Date.now() + Number(data.expires_in) * 1000 - 60_000,
        };
        saveVgbndSession(updated);
        return updated;
      } catch {
        clearVgbndSession();
        return null;
      }
    }

    async function vgbndListCharacters(session) {
      const res = await fetch(FS_BASE + ":runQuery", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + session.idToken,
        },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: "characters" }],
            where: {
              fieldFilter: {
                field: { fieldPath: "userId" },
                op: "EQUAL",
                value: { stringValue: session.uid },
              },
            },
          },
        }),
      });
      if (!res.ok) throw new Error("Firestore query failed: HTTP " + res.status);
      const rows = await res.json();
      return rows
        .filter(r => r.document)
        .map(r => ({
          id: r.document.name.split("/").pop(),
          ...fsFields(r.document.fields ?? {}),
        }));
    }

    function openVgbnd() {
      document.getElementById("vgbndOverlay").style.display = "flex";
      renderVgbndState();
    }
    function closeVgbnd() {
      document.getElementById("vgbndOverlay").style.display = "none";
    }

    async function renderVgbndState() {
      const session = await vgbndGetSession();
      if (session) renderVgbndBrowser(session);
      else renderVgbndSignIn();
    }

    function renderVgbndSignIn(errorMsg = "") {
      document.getElementById("vgbndTitle").textContent = "Sign in to vgbnd.app";
      const body = document.getElementById("vgbndBody");
      body.innerHTML =
        '<form id="vgbndForm" style="display:flex;flex-direction:column;gap:8px">' +
          '<input type="email" id="vgbndEmail" placeholder="email" autocomplete="email" required>' +
          '<input type="password" id="vgbndPassword" placeholder="password" autocomplete="current-password" required>' +
          (errorMsg ? '<div class="error-msg">' + esc(errorMsg) + '</div>' : '') +
          '<button type="submit" id="vgbndSignInBtn">Sign in</button>' +
        '</form>' +
        '<div class="hint">No account? Create one at <a href="https://www.vgbnd.app" target="_blank" rel="noopener">vgbnd.app</a></div>';

      document.getElementById("vgbndForm").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const email = document.getElementById("vgbndEmail").value.trim();
        const password = document.getElementById("vgbndPassword").value;
        const btn = document.getElementById("vgbndSignInBtn");
        btn.disabled = true;
        btn.textContent = "Signing in...";
        try {
          const session = await vgbndSignIn(email, password);
          renderVgbndBrowser(session);
        } catch (e) {
          renderVgbndSignIn(e.message);
        }
      });
    }

    async function renderVgbndBrowser(session) {
      document.getElementById("vgbndTitle").textContent = "vgbnd.app characters";
      const body = document.getElementById("vgbndBody");
      body.innerHTML = '<div class="hint">Loading your characters...</div>';

      let chars;
      try {
        chars = await vgbndListCharacters(session);
      } catch (e) {
        body.innerHTML =
          '<div class="error-msg">' + esc(e.message) + '</div>' +
          '<div class="session-bar">' +
            '<span>' + esc(session.email) + '</span>' +
            '<button class="link" id="vgbndSignOutBtn" type="button">Sign out</button>' +
          '</div>';
        attachSignOut();
        return;
      }

      let listHtml;
      if (!chars.length) {
        listHtml = '<div class="hint">No characters found on this account.</div>';
      } else {
        chars.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        listHtml = '<div class="char-list">' + chars.map((c, idx) => {
          const cls = c.class || c.items?.find?.(i => i.type === "class")?.name;
          const anc = c.ancestry || c.items?.find?.(i => i.type === "ancestry")?.name;
          const lvl = c.level ?? c.system?.attributes?.level?.value;
          const info = [
            cls ? titleCase(cls) : "",
            anc ? titleCase(anc) : "",
            lvl ? "Lv " + lvl : "",
          ].filter(Boolean).join(" \u00B7 ");
          return (
            '<div class="remote-char">' +
              '<div style="flex:1;min-width:0">' +
                '<div class="rname">' + esc(c.name || "Unnamed") + '</div>' +
                (info ? '<div class="rinfo">' + esc(info) + '</div>' : '') +
              '</div>' +
              '<button data-idx="' + idx + '" class="vgbnd-import-btn">Import</button>' +
            '</div>'
          );
        }).join("") + '</div>';
      }

      body.innerHTML =
        listHtml +
        '<div class="session-bar">' +
          '<span>' + esc(session.email) + '</span>' +
          '<button class="link" id="vgbndSignOutBtn" type="button">Sign out</button>' +
        '</div>';

      body.querySelectorAll(".vgbnd-import-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          const char = chars[Number(btn.dataset.idx)];
          btn.disabled = true;
          btn.textContent = "...";
          try {
            await importVgbndCharacter(char);
            btn.textContent = "Imported";
          } catch (e) {
            setStatus("Import failed: " + e.message, "error");
            btn.disabled = false;
            btn.textContent = "Retry";
          }
        });
      });
      attachSignOut();
    }

    function attachSignOut() {
      const btn = document.getElementById("vgbndSignOutBtn");
      if (!btn) return;
      btn.addEventListener("click", () => {
        clearVgbndSession();
        renderVgbndSignIn();
      });
    }

    function titleCase(s) {
      return String(s || "")
        .replace(/[_-]+/g, " ")
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim();
    }

    // vgbnd.app native (Firestore) shape -> OBR Vagabond shape
    function mapNativeToVagabond(raw) {
      const base = raw.assignedStats || {};
      const bonus = raw.levelStats || {};
      const addStat = k => (Number(base[k]) || 0) + (Number(bonus[k]) || 0);
      const stats = {
        might: addStat("might"),
        dexterity: addStat("dexterity"),
        awareness: addStat("awareness"),
        reason: addStat("reason"),
        presence: addStat("presence"),
        luck: addStat("luck"),
      };

      const skillKeys = [
        "arcana","brawl","craft","detect","finesse","influence","leadership",
        "medicine","mysticism","performance","sneak","survival","melee","ranged",
      ];
      const trainedSet = new Set((raw.trained_skills || []).map(s => String(s).toLowerCase()));
      const training = {};
      for (const k of skillKeys) training[k] = trainedSet.has(k);

      const inv = Array.isArray(raw.inventory) ? raw.inventory : [];
      const inventory = {};
      let armor = 0;
      inv.forEach((it, idx) => {
        const isWeapon = it.category === "Weapon" || !!it.damage;
        if (it.category === "Armor" && it.is_equipped && typeof it.rating === "number") {
          armor = Math.max(armor, it.rating);
        }
        const propsDesc = Array.isArray(it.properties) && it.properties.length
          ? it.properties.join(", ")
          : (it.desc || "");
        const qty = Number(it.quantity) || 1;
        const id = uid();
        inventory[id] = {
          id,
          item: it.name || "",
          damage: isWeapon ? (it.damage || "") : "",
          description: propsDesc,
          info: qty > 1 ? "x" + qty : "",
          grip: isWeapon ? (it.grip || "1H") : "",
          order: idx,
        };
      });

      const abilities = {};
      let order = 0;
      // Add ancestry as an ability so its description (which contains the
      // trait list) shows up on the character sheet after compendium lookup.
      if (raw.ancestry) {
        const id = uid();
        abilities[id] = {
          id,
          name: titleCase(raw.ancestry),
          description: "",
          order: order++,
        };
      }
      // Class similarly carries the class description / level features.
      if (raw.class) {
        const id = uid();
        abilities[id] = {
          id,
          name: titleCase(raw.class),
          description: "",
          order: order++,
        };
      }
      for (const perk of (raw.selected_perks || [])) {
        if (!perk?.name) continue;
        const id = uid();
        abilities[id] = {
          id,
          name: perk.name,
          description: perk.description || "",
          order: order++,
        };
      }

      const spells = {};
      (raw.known_spells || []).forEach((sp, idx) => {
        const id = uid();
        const name = typeof sp === "string" ? titleCase(sp) : (sp?.name || titleCase(sp?.id || ""));
        spells[id] = {
          id,
          name,
          description: typeof sp === "object" ? (sp?.description || "") : "",
          info: "",
          order: idx,
        };
      });

      const wealth = raw.current_wealth || {};
      const id = uid();
      return {
        id,
        name: raw.name || "Imported",
        level: Number(raw.level) || 1,
        xp: Number(raw.xp) || 0,
        ancestry: titleCase(raw.ancestry || ""),
        class: titleCase(raw.class || ""),
        speed: "",
        speedBonus: "",
        size: "M",
        beingType: "Humanlike",
        stats,
        training,
        currentHP: Number(raw.current_hp) || 0,
        maxHP: Number(raw.current_hp) || 0,
        armor,
        currentMana: Number(raw.current_mana) || 0,
        maxMana: 0,
        maxCastingMana: 0,
        currentLuck: Number(raw.current_luck) || 0,
        fatigue: 0,
        wealth: {
          gold: Number(wealth.g) || 0,
          silver: Number(wealth.s) || 0,
          copper: Number(wealth.c) || 0,
        },
        inventory,
        abilities,
        spells,
      };
    }

    async function importVgbndCharacter(remote) {
      // Detect shape: foundry-shape has system/items; native has assignedStats
      const char = remote.system ? mapFoundryToVagabond(remote) : mapNativeToVagabond(remote);
      await enhanceWithCompendium(char);
      const metadata = await OBR.scene.getMetadata();
      const existing = { ...(metadata[METADATA_KEY] || {}) };
      existing[char.id] = char;
      await OBR.scene.setMetadata({ [METADATA_KEY]: existing });
      selectedId = char.id;
      setStatus("Imported " + char.name, "success");
      await loadCharacters();
    }

    document.getElementById("exportBtn").addEventListener("click", () => window.exportPDF());
    document.getElementById("exportFoundryBtn").addEventListener("click", () => window.exportFoundryJSON());
    document.getElementById("importFileBtn").addEventListener("click", () => {
      document.getElementById("importFile").click();
    });

    document.getElementById("vgbndBtn").addEventListener("click", openVgbnd);
    document.getElementById("vgbndClose").addEventListener("click", closeVgbnd);
    document.getElementById("vgbndOverlay").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeVgbnd();
    });

    // Accept 8-4-4-4-12 hex with any non-hex separator (dash, en-dash, em-dash,
    // space, underscore, none), case-insensitive. Normalized to canonical UUID.
    const UUID_RE = /([0-9a-f]{8})[^0-9a-f]?([0-9a-f]{4})[^0-9a-f]?([0-9a-f]{4})[^0-9a-f]?([0-9a-f]{4})[^0-9a-f]?([0-9a-f]{12})/i;

    document.getElementById("vgbndUrlBtn").addEventListener("click", async () => {
      const input = prompt("Paste a vgbnd.app character URL or ID:");
      if (!input) return;
      const trimmed = input.trim();
      const match = UUID_RE.exec(trimmed);
      if (!match) {
        const preview = trimmed.length > 50 ? trimmed.slice(0, 47) + "..." : trimmed;
        setStatus('No character ID in: "' + preview + '"', "error");
        console.log("URL import raw input:", JSON.stringify(trimmed));
        return;
      }
      const id = match.slice(1).join("-").toLowerCase();
      const btn = document.getElementById("vgbndUrlBtn");
      btn.disabled = true;
      setStatus("Fetching character...", "");
      try {
        // vgbnd.app doesn't send CORS headers, so we route through a public proxy.
        // ?format=foundry drops spells, so fetch native shape and use the native mapper.
        const targetUrl = "https://www.vgbnd.app/api/characters/" + id;
        const proxyUrl = "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(targetUrl);
        const res = await fetch(proxyUrl);
        if (!res.ok) {
          if (res.status === 403 || res.status === 404) {
            throw new Error("Character is private or not found. Try signing in instead.");
          }
          throw new Error("HTTP " + res.status + " from proxy");
        }
        const body = await res.json();
        if (body && body.error && !body.character) {
          // Proxy returned an error envelope instead of character data
          const msg = typeof body.error === "string"
            ? body.error
            : (body.error.message || JSON.stringify(body.error).slice(0, 120));
          throw new Error("Proxy/API error: " + msg);
        }
        const native = body.character || body;
        if (!native || !native.name || !native.assignedStats) {
          throw new Error("Response didn't look like a Vagabond character");
        }
        const char = mapNativeToVagabond(native);
        await enhanceWithCompendium(char);
        const metadata = await OBR.scene.getMetadata();
        const existing = { ...(metadata[METADATA_KEY] || {}) };
        existing[char.id] = char;
        await OBR.scene.setMetadata({ [METADATA_KEY]: existing });
        selectedId = char.id;
        setStatus("Imported " + char.name, "success");
        await loadCharacters();
      } catch (e) {
        setStatus("Import failed: " + e.message, "error");
        console.error(e);
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById("importFile").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file) return;
      try {
        setStatus("Reading " + file.name + "...", "");
        const text = await file.text();
        const foundry = JSON.parse(text);
        if (foundry.type && foundry.type !== "character") {
          throw new Error("Not a character actor (type: " + foundry.type + ")");
        }
        const char = mapFoundryToVagabond(foundry);
        await enhanceWithCompendium(char);

        const metadata = await OBR.scene.getMetadata();
        const existing = { ...(metadata[METADATA_KEY] || {}) };
        existing[char.id] = char;
        await OBR.scene.setMetadata({ [METADATA_KEY]: existing });

        selectedId = char.id;
        setStatus("Imported " + char.name, "success");
        await loadCharacters();
      } catch (err) {
        setStatus("Import failed: " + err.message, "error");
        console.error(err);
      }
    });

    // --- Foundry JSON export ---

    function escapeHtml(s) {
      return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    const SKILL_KEYS = [
      "arcana","brawl","craft","detect","finesse","influence","leadership",
      "medicine","mysticism","performance","sneak","survival","melee","ranged",
    ];

    const SIZE_TO_FOUNDRY = { T: "tiny", S: "small", M: "medium", L: "large", H: "huge", G: "gargantuan" };

    function mapVagabondToFoundry(char) {
      const s = char.stats || {};
      const t = char.training || {};
      const items = [];

      if (char.ancestry) {
        items.push({
          name: char.ancestry,
          type: "ancestry",
          img: "icons/svg/mystery-man.svg",
          system: {
            description: "",
            size: SIZE_TO_FOUNDRY[char.size] || "medium",
            ancestryType: "",
            traits: [],
          },
          effects: [],
          sort: 0,
          flags: {},
          ownership: { default: 0 },
        });
      }

      if (char.class) {
        items.push({
          name: char.class,
          type: "class",
          img: "icons/svg/mystery-man.svg",
          system: {
            description: "",
            isSpellcaster: Number(char.maxMana) > 0,
            levelFeatures: [],
            manaSkill: null,
            castingStat: "reason",
            manaMultiplier: 0,
            skillGrant: { guaranteed: [], choices: [] },
            levelSpells: [],
            keyStats: [],
            suggestedStartingPacks: [],
          },
          effects: [],
          sort: 0,
          flags: {},
          ownership: { default: 0 },
        });
      }

      const abilities = Object.values(char.abilities || {}).sort((a, b) => (a.order || 0) - (b.order || 0));
      abilities.forEach((ab, i) => {
        items.push({
          name: ab.name || "Ability",
          type: "perk",
          img: "icons/svg/book.svg",
          system: {
            description: ab.description ? "<p>" + escapeHtml(ab.description) + "</p>" : "",
            prerequisites: {
              stats: [], trainedSkills: [], spells: [],
              statOrGroups: [], trainedSkillOrGroups: [], spellOrGroups: [],
              hasAnySpell: false, resources: [], resourceOrGroups: [],
            },
            choiceConfig: { type: "none", selected: "", targetField: "", effectMode: 5, effectValue: "1" },
          },
          effects: [],
          sort: (i + 1) * 100000,
          flags: {},
          ownership: { default: 0 },
        });
      });

      const inv = Object.values(char.inventory || {}).sort((a, b) => (a.order || 0) - (b.order || 0));
      inv.forEach((item, i) => {
        const isWeapon = !!item.damage;
        let quantity = 1;
        const m = /^x?(\d+)$/i.exec(String(item.info || "").trim());
        if (m) quantity = parseInt(m[1], 10) || 1;

        const grip = (item.grip === "2H" || item.grip === "1H") ? item.grip : "1H";

        items.push({
          name: item.item || "Item",
          type: "equipment",
          img: isWeapon ? "icons/weapons/swords/sword-guard-brown.webp" : "icons/containers/bags/pack-leather-brown.webp",
          system: {
            description: item.description ? "<p>" + escapeHtml(item.description) + "</p>" : "",
            equipmentType: isWeapon ? "weapon" : "gear",
            locked: false,
            equipped: isWeapon,
            quantity,
            baseCost: { gold: 0, silver: 0, copper: 0 },
            baseSlots: 1,
            metal: "none",
            damageType: "-",
            damageAmount: "",
            properties: [],
            weaponSkill: "melee",
            range: "close",
            grip,
            damageOneHand: isWeapon ? (item.damage || "") : "",
            damageTwoHands: isWeapon ? (item.damage || "") : "",
            equipmentState: isWeapon ? (grip === "2H" ? "twoHand" : "oneHand") : "unequipped",
            armorType: "light",
            immunities: [],
            gearCategory: "",
            alchemicalType: "concoction",
            lore: "",
            damageTypeOneHand: "-",
            damageTypeTwoHands: "-",
            requiresBound: false,
            bound: false,
            gridPosition: 0,
            containerId: null,
            canExplode: false,
            explodeValues: "",
            isSupply: false,
            isBeverage: false,
            isConsumable: false,
            linkedConsumable: "",
            passiveCausedStatuses: [],
            causedStatuses: [],
            critCausedStatuses: [],
            blockedStatuses: [],
            resistedStatuses: [],
            coating: { sourceName: "", charges: 0, causedStatuses: [] },
          },
          effects: [],
          sort: (i + 1) * 100000,
          flags: {},
          ownership: { default: 0 },
        });
      });

      const spells = Object.values(char.spells || {}).sort((a, b) => (a.order || 0) - (b.order || 0));
      spells.forEach((sp, i) => {
        items.push({
          name: sp.name || "Spell",
          type: "spell",
          img: "icons/svg/explosion.svg",
          system: {
            description: sp.description ? "<p>" + escapeHtml(sp.description) + "</p>" : "",
          },
          effects: [],
          sort: (i + 1) * 100000,
          flags: {},
          ownership: { default: 0 },
        });
      });

      const statBlock = k => ({ value: Number(s[k]) || 0, bonus: [] });
      const skillBlock = Object.fromEntries(
        SKILL_KEYS.map(k => [k, { trained: !!t[k], bonus: [] }])
      );

      return {
        name: char.name || "Unnamed",
        type: "character",
        img: "icons/svg/mystery-man.svg",
        system: {
          attributes: {
            level: { value: Number(char.level) || 1 },
            xp: Number(char.xp) || 0,
            size: null,
            beingType: char.beingType || null,
            isSpellcaster: Number(char.maxMana) > 0,
            manaMultiplier: 0,
            castingStat: "reason",
            manaSkill: null,
          },
          details: { builderDismissed: true, constructed: false },
          stats: {
            might: statBlock("might"),
            dexterity: statBlock("dexterity"),
            awareness: statBlock("awareness"),
            reason: statBlock("reason"),
            presence: statBlock("presence"),
            luck: statBlock("luck"),
          },
          skills: skillBlock,
          health: { value: Number(char.currentHP) || 0, max: Number(char.maxHP) || 0, bonus: [] },
          mana: {
            current: Number(char.currentMana) || 0,
            max: Number(char.maxMana) || 0,
            castingMax: Number(char.maxCastingMana) || 0,
            bonus: [],
            castingMaxBonus: [],
          },
          currentLuck: Number(char.currentLuck) || 0,
          fatigue: Number(char.fatigue) || 0,
          fatigueBonus: [],
          biography: "",
          currency: {
            gold: Number(char.wealth?.gold) || 0,
            silver: Number(char.wealth?.silver) || 0,
            copper: Number(char.wealth?.copper) || 0,
          },
          inventory: { bonusSlots: [], boundsBonus: [] },
          focus: { spellIds: [], maxBonus: [], max: 5, current: 0 },
          speed: { bonus: [] },
          bonusLuck: [],
          armorBonus: Number(char.armor) ? [{ value: String(Number(char.armor)), source: "Imported" }] : [],
          saves: { reflex: { bonus: [] }, endure: { bonus: [] }, will: { bonus: [] } },
          immunities: [],
          weaknesses: [],
          statusImmunities: [],
          statusResistances: [],
        },
        items,
        effects: [],
        folder: null,
        flags: {},
        ownership: { default: 0 },
      };
    }

    window.exportFoundryJSON = function exportFoundryJSON() {
      const char = characters.find(c => c.id === selectedId);
      if (!char) return;
      try {
        const actor = mapVagabondToFoundry(char);
        const blob = new Blob([JSON.stringify(actor, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const safeName = String(char.name || "character").replace(/[^\w-]+/g, "_");
        a.href = url;
        a.download = "fvtt-Actor-" + safeName + ".json";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setStatus("Foundry JSON downloaded!", "success");
      } catch (e) {
        setStatus("Export failed: " + e.message, "error");
        console.error(e);
      }
    };

    // Expose exportPDF globally so the onclick can call it
    window.exportPDF = async function exportPDF() {
      const char = characters.find(c => c.id === selectedId);
      if (!char) return;

      setStatus("Generating PDF...", "");
      document.getElementById("exportBtn").disabled = true;

      try {
        const { PDFDocument } = PDFLib;

        // Load the blank Hero Record PDF from the same directory
        const res = await fetch("blank.pdf");
        if (!res.ok) throw new Error("Could not load blank.pdf");
        const pdfBytes = await res.arrayBuffer();
        const pdfDoc = await PDFDocument.load(pdfBytes);
        const form = pdfDoc.getForm();

        // Replace common Unicode symbols with ASCII equivalents,
        // then strip anything else outside WinAnsi range
        function sanitize(str) {
          return String(str)
            .replace(/\u2605/g, "*")   // ★ black star
            .replace(/\u2606/g, "*")   // ☆ white star
            .replace(/\u2014/g, "--")  // — em dash
            .replace(/\u2013/g, "-")   // – en dash
            .replace(/\u2018/g, "'")   // ' left single quote
            .replace(/\u2019/g, "'")   // ' right single quote
            .replace(/\u201C/g, '"')   // " left double quote
            .replace(/\u201D/g, '"')   // " right double quote
            .replace(/\u2022/g, "-")   // • bullet
            .replace(/\u2026/g, "...")  // … ellipsis
            .replace(/\u2192/g, "->")  // → arrow
            .replace(/\u2190/g, "<-")  // ← arrow
            .replace(/\u00D7/g, "x")   // × multiplication
            .replace(/[^\x00-\x7F\xA0-\xFF]/g, "");
        }
        function sf(name, val) {
          try { form.getTextField(name).setText(val != null && val !== "" ? sanitize(val) : ""); } catch(e) {}
        }
        function sc(name, val) {
          try { if (val) form.getCheckBox(name).check(); else form.getCheckBox(name).uncheck(); } catch(e) {}
        }
        function sd(name, val) {
          try { form.getDropdown(name).select(String(val)); } catch(e) {}
        }

        const s = char.stats || {};
        const t = char.training || {};

        // Identity
        sf("Name", char.name);
        sf("Level", char.level);
        sf("XP", char.xp);
        sf("Ancestry", char.ancestry);
        sf("Class", char.class);
        sf("Speed", char.speed);
        sf("Speed Bonus", char.speedBonus);
        sd("Size", char.size || "M");
        sd("Being Type", char.beingType || "Humanlike");

        // Stats (Reason in Vagabond -> LOG in PDF)
        sf("MIT", s.might);
        sf("DEX", s.dexterity);
        sf("AWR", s.awareness);
        sf("LOG", s.reason);
        sf("PRS", s.presence);
        sf("LUK", s.luck);

        // Resources
        sf("Current HP", char.currentHP);
        sf("Max HP", char.maxHP);
        sf("Armor Rating", char.armor);
        sf("Current Mana", char.currentMana);
        sf("Max Mana", char.maxMana);
        sf("Casting Maximum", char.maxCastingMana);
        sf("Current Luck", char.currentLuck);
        sf("Fatigue", char.fatigue);

        // Skill difficulty formula: 20 - stat × (trained ? 2 : 1)
        function calcDiff(stat, trained) {
          return 20 - (stat || 0) * (trained ? 2 : 1);
        }

        // Skills: [trainedField, difficultyField, statKey]
        const skillMap = {
          arcana:      ["Arcana Trained",      "Arcana Skill Difficulty",      "reason"],
          brawl:       ["Brawn Trained",        "Brawn Skill Difficulty",       "might"],
          craft:       ["Craft Trained",        "Craft Skill Difficulty",       "reason"],
          detect:      ["Detect Trained",       "Detect Skill Difficulty",      "awareness"],
          finesse:     ["Finesse Trained",      "Finesse Skill Difficulty",     "dexterity"],
          influence:   ["Influence Trained",    "Influence Skill Difficulty",   "presence"],
          leadership:  ["Leadership Trained",   "Leadership Skill Difficulty",  "presence"],
          medicine:    ["Medicine Trained",     "Medicine Skill Difficulty",    "reason"],
          mysticism:   ["Mysticism Trained",    "Mysticism Skill Difficulty",   "awareness"],
          performance: ["Performance Trained",  "Performance Skill Difficulty", "presence"],
          sneak:       ["Sneak Trained",        "Sneak Skill Difficulty",       "dexterity"],
          survival:    ["Survival Trained",     "Survival Skill Difficulty",    "awareness"],
        };
        for (const [key, [trainedField, diffField, statKey]] of Object.entries(skillMap)) {
          const trained = t[key];
          sc(trainedField, trained);
          sf(diffField, calcDiff(s[statKey], trained));
        }

        // Attacks
        sc("Melee Weapons Trained", t.melee);
        sf("Melee Attack Check Difficulty", calcDiff(s.might, t.melee));
        sc("Ranged Weapons Trained", t.ranged);
        sf("Ranged Attack Difficulty", calcDiff(s.awareness, t.ranged));

        // Saves: 20 - (statA + statB)
        sf("Reflex Save Difficulty", 20 - ((s.dexterity || 0) + (s.awareness || 0)));
        sf("Endure Save Difficulty", 20 - ((s.might || 0) + (s.might || 0)));
        sf("Will Save Difficulty", 20 - ((s.reason || 0) + (s.presence || 0)));

        // Inventory — items with damage are weapons, the rest are gear
        const allItems = Object.values(char.inventory || {}).sort((a, b) => (a.order || 0) - (b.order || 0));
        const weapons = allItems.filter(item => item.damage);
        const gear = allItems.filter(item => !item.damage);

        weapons.forEach((w, i) => {
          if (i >= 3) return;
          sf("Weapon " + (i + 1), w.item || "");
          sf("Weapon Damage " + (i + 1), w.damage || "");
          sf("Weapon Properties " + (i + 1), w.description || "");
          sd("Grip " + (i + 1), w.grip || "F");
        });

        gear.forEach((item, i) => {
          if (i >= 14) return;
          const label = item.info ? item.item + " (" + item.info + ")" : item.item;
          sf("Inventory " + (i + 1), label);
        });

        // Wealth
        const wl = char.wealth || {};
        sf("Wealth (g)", wl.gold);
        sf("Wealth (s)", wl.silver);
        sf("Wealth (c)", wl.copper);

        // Abilities
        const abilities = Object.values(char.abilities || {}).sort((a, b) => (a.order || 0) - (b.order || 0));
        const abText = abilities.map(a => (a.name || "") + ": " + (a.description || "")).join("\n\n");
        sf("Abilities", abText);

        // Spells
        const spells = Object.values(char.spells || {}).sort((a, b) => (a.order || 0) - (b.order || 0));
        const spellText = spells.map(sp =>
          (sp.name || "") + (sp.info ? " [" + sp.info + "]" : "") + ": " + (sp.description || "")
        ).join("\n\n");
        sf("Magic 1", spellText);

        // Do NOT flatten — the importer needs live form fields
        const filledBytes = await pdfDoc.save();
        const blob = new Blob([filledBytes], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = (char.name || "character") + "-hero-record.pdf";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        setStatus("PDF downloaded!", "success");
      } catch (e) {
        setStatus("Export failed: " + e.message, "error");
        console.error(e);
      }

      document.getElementById("exportBtn").disabled = false;
    };
  