"use strict";

(() => {
  const t = (source = "", ...values) => globalThis.__weAgoI18n?.t(source, ...values)
    ?? (typeof source === "string" ? source : source.reduce((text, part, i) => text + part + (i < values.length ? values[i] : ""), ""));

  const OWNED = '[data-we-ago="true"]', HOUR = 3600000;
  const SLOTS = ["weapon", "helmet", "chest", "pants", "gloves", "boots"];
  const sessions = new Map();
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const positive = value => finite(value) && value > 0;
  const isId = value => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
  const unwrap = value => value && Object.hasOwn(value, "json") ? value.json : value;
  const fmt = value => finite(value) ? value.toLocaleString(globalThis.__weAgoI18n?.locale || "en-US", { maximumFractionDigits: 1 }) : "—";
  const compact = value => finite(value) ? value.toLocaleString(globalThis.__weAgoI18n?.locale || "en-US", { notation: "compact", maximumFractionDigits: 1 }) : "—";
  const clock = ms => {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  };
  function route() {
    const url = new URL(location.href);
    const match = /^\/(user|battle|mu|country)\/([a-f\d]{24})(?:\/(?:members|citizens))?\/?$/i.exec(url.pathname);
    return match ? { kind: match[1].toLowerCase(), id: match[2].toLowerCase(), key: url.href } : null;
  }
  function owned(tag, name, text, svg = false) {
    const node = svg ? document.createElementNS("http://www.w3.org/2000/svg", tag) : document.createElement(tag);
    node.setAttribute("class", "we-ago-spy-" + name);
    node.dataset.weAgo = "true";
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function targets() {
    const candidates = new Map(), info = route();
    const summary = info && ["country", "mu"].includes(info.kind)
      && document.querySelector(`.we-ago-country-builds-card[data-scope="${info.kind}"][data-entity-id="${info.id}"]`);
    const scope = document.getElementById?.("main-window") || document;
    for (const link of scope.querySelectorAll('a[href*="/user/"]')) {
      const census = link.closest(".we-ago-country-table");
      if (summary && !census) continue;
      if (link.closest(OWNED) && !census || link.closest('nav, aside, header, [role="log"], [aria-label*="chat" i], [data-testid*="chat" i]')
        || !link.textContent.trim() || !link.getClientRects().length) continue;
      const rect = link.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) continue;
      let url;
      try { url = new URL(link.getAttribute("href"), location.href); } catch { continue; }
      const match = /^\/user\/([a-f\d]{24})\/?$/i.exec(url.pathname);
      if (url.origin !== location.origin || !match) continue;
      const userId = match[1].toLowerCase();
      // Chat names, quotations, officials and random profile links are not
      // roster rows. Prefer the census list, and show each player only once.
      const roster = census || link.closest('table, [role="table"], [data-testid*="fighter" i], [aria-label*="fighter" i]');
      if (!roster && !(info?.kind === "user" && info.id === userId)) continue;
      const priority = census ? 2 : roster ? 1 : 0;
      if (!candidates.has(userId) || priority > candidates.get(userId).priority) candidates.set(userId, { link, priority });
    }
    return new Map([...candidates].slice(0, 200).map(([userId, { link }]) => [link, userId]));
  }

  // Adapted from the user's battle planner: existing effects only, not a new
  // pill schedule. Cocain is the actual game code, rather than "pill1" etc.
  function pillState(user, config, now) {
    const unknown = { kind: "unknown", buffEnd: 0, debuffEnd: 0 };
    const ready = { kind: "ready", buffEnd: 0, debuffEnd: 0 };
    const b = user?.buffs;
    if (b === null) return ready;
    if (!b) return user?.skills?.attack?.buffsPercent === 0 && user?.skills?.attack?.debuffsPercent === 0 ? ready : unknown;
    if ((b.buffCodes !== undefined && !Array.isArray(b.buffCodes)) || (b.debuffCodes !== undefined && !Array.isArray(b.debuffCodes))) return unknown;
    if (!Array.isArray(b.buffCodes) && !Array.isArray(b.debuffCodes)) return unknown;
    const buff = b.buffCodes ?? [], debuff = b.debuffCodes ?? [];
    let buffEnd = typeof b.buffEndAt === "string" ? Date.parse(b.buffEndAt) : NaN;
    let debuffEnd = typeof b.debuffEndAt === "string" ? Date.parse(b.debuffEndAt) : NaN;
    const duration = config?.items?.cocain?.flatStats?.debuffDurationHours;
    if (!finite(debuffEnd) && (buff.includes("cocain") || debuff.includes("cocain")) && finite(buffEnd) && positive(duration)) debuffEnd = buffEnd + duration * HOUR;
    if (buff.length && !finite(buffEnd) || debuff.length && !finite(debuffEnd)) return unknown;
    if (buff.length && buffEnd > now) return { kind: "buff", buffEnd, debuffEnd: finite(debuffEnd) ? debuffEnd : 0,
      forecastKnown: !buff.includes("cocain") || finite(debuffEnd) };
    if ((debuff.length || buff.includes("cocain")) && debuffEnd > now) return { kind: "debuff", buffEnd: finite(buffEnd) ? buffEnd : 0, debuffEnd };
    if (buff.includes("cocain") && !finite(debuffEnd)) return unknown;
    return ready;
  }

  // The planner's expectation formula, using actual equipped skill rolls and
  // ammo instead of its hypothetical purple set. No unverified battle bonus.
  function damagePotential(user, equipment, config, now) {
    const s = user?.skills;
    if (!s || !equipment || !config?.battle || !config?.skills) return null;
    const base = key => {
      const skill = globalThis.__weAgoDomain.skill(s, key);
      const value = skill?.value ?? globalThis.__weAgoDomain.skill(config.skills, key)?.levels?.[skill?.level]?.value;
      return finite(value) && (skill?.prestige === undefined || finite(skill.prestige)) ? value + (skill.prestige ?? 0) : NaN;
    };
    function gear(key) {
      let total = 0;
      for (const slot of SLOTS) {
        const item = equipment[slot];
        if (item == null) continue;
        if (typeof item !== "object" || Array.isArray(item) || !item.skills || typeof item.skills !== "object"
          || finite(item.state) && item.state <= 0) return NaN;
        const value = globalThis.__weAgoDomain.skill(item.skills, key) ?? 0;
        if (!finite(value)) return NaN;
        total += value;
      }
      return total;
    }
    const precision = base("precision") + gear("precision");
    const critical = base("criticalChance") + gear("criticalChance");
    const precisionOverflow = Math.max(0, precision - 100);
    const criticalOverflow = Math.max(0, critical - 100);
    const attack = base("attack") + gear("attack") + (precisionOverflow ? precisionOverflow * config.skills.precision?.skillOverflowValue : 0);
    const criticalDamage = base("criticalDamages") + gear("criticalDamages") + (criticalOverflow ? criticalOverflow * config.skills.criticalChance?.skillOverflowValue : 0);
    const armor = base("armor") + gear("armor"), dodge = base("dodge") + gear("dodge");
    const ammo = equipment.ammo;
    const ammoPercent = ammo == null ? 0 : config.items?.[ammo]?.flatStats?.percentAttack;
    const rank = s.attack?.militaryRankPercent;
    let multiplier;
    const state = pillState(user, config, now);
    const codes = [...(Array.isArray(user.buffs?.buffCodes) ? user.buffs.buffCodes : []), ...(Array.isArray(user.buffs?.debuffCodes) ? user.buffs.debuffCodes : [])];
    if (codes.includes("cocain")) {
      const boost = config.items?.cocain?.flatStats?.percentAttack;
      multiplier = state.kind === "ready" ? 1 : finite(boost) && state.kind !== "unknown" ? 1 + (state.kind === "buff" ? boost : -boost) / 100 : NaN;
    } else if (finite(s.attack?.buffsPercent) && finite(s.attack?.debuffsPercent)) {
      multiplier = 1 + ((state.kind === "ready" ? 0 : s.attack.buffsPercent) - (state.kind === "ready" ? 0 : s.attack.debuffsPercent)) / 100;
    }
    else {
      const boost = config.items?.cocain?.flatStats?.percentAttack;
      multiplier = state.kind === "ready" ? 1 : finite(boost) && ["buff", "debuff"].includes(state.kind)
        && [...(user.buffs?.buffCodes ?? []), ...(user.buffs?.debuffCodes ?? [])].includes("cocain")
        ? 1 + (state.kind === "buff" ? boost : -boost) / 100 : NaN;
    }
    const armorCap = config.skills.armor?.softCap, dodgeCap = config.skills.dodge?.softCap;
    const healthCost = config.battle.healthCost;
    const health = s.health?.currentBarValue, maxHealth = s.health?.total;
    const hunger = s.hunger?.currentBarValue, maxHunger = s.hunger?.total;
    const foodPercent = config.items?.cookedFish?.flatStats?.healthRegenPercent;
    if (![precision, critical, attack, criticalDamage, armor, dodge, ammoPercent, rank, multiplier, health, maxHealth, hunger, maxHunger, foodPercent].every(finite)
      || ![armorCap, dodgeCap, healthCost, maxHealth].every(positive)
      || [attack, criticalDamage, armor, dodge, health, hunger, maxHunger, foodPercent, multiplier].some(value => value < 0)
      || ammo != null && equipment.ammoQuantity === 0) return null;
    const p = Math.max(0, Math.min(100, precision)) / 100, c = Math.max(0, Math.min(100, critical)) / 100;
    const hit = attack * (1 + ammoPercent / 100) * (1 + rank / 100) * multiplier * (.5 + .5 * p + p * c * criticalDamage / 100);
    const hpPerHit = healthCost * armorCap / (armor + armorCap) * dodgeCap / (dodge + dodgeCap);
    const foodHealth = maxHealth * foodPercent / 100;
    const result = hit / hpPerHit * (Math.min(health, maxHealth) + Math.floor(Math.min(hunger, maxHunger)) * foodHealth);
    return finite(result) && result >= 0 ? result : null;
  }

  // Same invested-skill thresholds as the census, including legacy formats.
  function buildKind(user) {
    try { return globalThis.__weAgoDomain.classify(user)?.build ?? null; } catch { return null; }
  }
  const combatBuild = user => ["damage", "hybrid"].includes(buildKind(user));

  function population(users, config, now) {
    const states = users.filter(combatBuild).map(user => pillState(user, config, now)).filter(s => s.kind !== "unknown" && s.forecastKnown !== false);
    // Sweep expiry events once. A country can have thousands of citizens;
    // rescanning every player at every transition would be quadratic.
    const end = now + 24 * HOUR, events = new Map(), counts = { buff: 0, debuff: 0, ready: 0 };
    const transition = (at, from, to) => {
      if (at <= now || at > end) return;
      const delta = events.get(at) ?? { buff: 0, debuff: 0, ready: 0 };
      delta[from]--; delta[to]++; events.set(at, delta);
    };
    for (const state of states) {
      counts[state.kind]++;
      if (state.kind === "buff") {
        const hasDebuff = state.debuffEnd > state.buffEnd;
        transition(state.buffEnd, "buff", hasDebuff ? "debuff" : "ready");
        if (hasDebuff) transition(state.debuffEnd, "debuff", "ready");
      } else if (state.kind === "debuff") transition(state.debuffEnd, "debuff", "ready");
    }
    const data = [{ at: now, ...counts }];
    for (const [at, delta] of [...events].sort(([a], [b]) => a - b)) {
      for (const kind of ["buff", "debuff", "ready"]) counts[kind] += delta[kind];
      data.push({ at, ...counts });
    }
    if (data.at(-1).at !== end) data.push({ at: end, ...counts });
    return { data, included: states.length };
  }

  function snapshot(result, ttl = 120000) {
    const now = Date.now();
    if (!finite(result?.createdAt) || !finite(result.expiresAt) || result.createdAt > now) throw new Error("Invalid cache metadata");
    const expiresAt = Math.min(result.expiresAt, result.createdAt + ttl);
    return { data: unwrap(result.data), expiresAt };
  }
  const fresh = record => record?.expiresAt > Date.now();
  const due = record => !fresh(record) && !(record?.retryAt > Date.now());
  function sufficientProfile(user, config, rows = false) {
    if (!user || buildKind(user) === null) return false;
    const state = pillState(user, config, Date.now());
    if (state.kind === "unknown" || state.forecastKnown === false) return false;
    // Prove all profile-side damage/resource inputs without assuming any gear
    // rolls. A Lite/roster record with only invested skills cannot satisfy rows.
    return !rows || damagePotential(user, {}, config, Date.now()) !== null;
  }
  function release(session, owner) {
    if (!session) return;
    session.owners.delete(owner);
    if (!session.owners.size) { session.alive = false; sessions.delete(session.info.key); }
  }
  function acquire(info, owner) {
    let session = sessions.get(info.key);
    if (!session) {
      session = { info, owners: new Set(), profiles: new Map(), equipment: new Map(), roster: null,
        config: null, alive: true, pending: false, nextBatch: 0, profileCursor: 0, revision: 0, error: "" };
      sessions.set(info.key, session);
    }
    session.owners.add(owner);
    return session;
  }
  const has = (session, mode) => [...session.owners].some(owner => owner.mode === mode);
  function addJob(jobs, procedure, input, apply, fail, ttlSeconds = 120) {
    jobs.push({ call: { procedure, input, ttlSeconds }, apply, fail });
  }
  async function pump(session, found) {
    if (!session.alive || session.pending || document.hidden || Date.now() < session.nextBatch) return;
    // Also throttle empty/fresh passes shared by row and graph clients.
    session.nextBatch = Date.now() + 1100;
    const jobs = [], info = session.info;
    const live = () => session.alive && route()?.key === info.key;
    if (due(session.config)) addJob(jobs, "gameConfig.getGameConfig", {}, value => {
      session.config = snapshot(value, 600000);
    }, () => { session.config = { ...session.config, retryAt: Date.now() + 30000 }; }, 600);
    if (has(session, "timeline") && (!session.roster || session.roster.expiresAt <= Date.now() || session.roster.loading)
      && !(session.roster?.retryAt > Date.now())) {
      if (!session.roster || !session.roster.loading) session.roster = { ids: session.roster?.ids ?? new Set(), populated: session.roster?.populated ?? new Map(), scanning: new Set(), cursors: new Set(), loading: true, cursor: null, expiresAt: Infinity, partial: false };
      const roster = session.roster;
      const input = info.kind === "mu" ? { muId: info.id } : { countryId: info.id, limit: 100, ...(roster.cursor ? { cursor: roster.cursor } : {}) };
      addJob(jobs, info.kind === "mu" ? "mu.getById" : "user.getUsersByCountry", input, value => {
        if (!has(session, "timeline")) return;
        const result = snapshot(value), data = result.data;
        if (info.kind === "mu" && (data?._id ?? data?.id) !== info.id) throw new Error("MU identity mismatch");
        const items = info.kind === "mu" ? data?.members : Array.isArray(data) ? data : data?.items ?? data?.users;
        if (!Array.isArray(items)) throw new Error("Roster unavailable");
        for (const item of items) {
          if (roster.scanning.size >= 10000) { roster.partial = true; break; }
          const user = item?.user && typeof item.user === "object" ? item.user : item;
          const userId = typeof user === "string" ? user : user?._id ?? user?.userId ?? user?.user;
          if (!isId(userId)) { roster.partial = true; continue; }
          roster.scanning.add(userId.toLowerCase()); roster.ids.add(userId.toLowerCase());
          if (user && typeof user === "object") roster.populated.set(userId.toLowerCase(), {
            data: { ...user, _id: userId.toLowerCase() }, expiresAt: result.expiresAt, source: "roster"
          });
        }
        roster.expiresAt = Math.min(roster.expiresAt, result.expiresAt);
        const cursor = info.kind === "country" ? data?.nextCursor ?? data?.cursor : null;
        if (cursor && (typeof cursor !== "string" || roster.cursors.has(cursor))) throw new Error("Country pagination did not advance");
        if (cursor) roster.cursors.add(cursor);
        roster.cursor = cursor;
        roster.loading = Boolean(cursor);
        if (roster.ids.size > 10000 || roster.cursors.size >= 100) { roster.loading = false; roster.partial = true; }
        if (!roster.loading) roster.ids = roster.scanning;
      }, () => { roster.loading = false; roster.partial = true; roster.retryAt = Date.now() + 30000; roster.expiresAt = 0; });
    }
    const visible = has(session, "rows") ? new Set(found.values()) : new Set();
    const rosterIds = has(session, "timeline") ? session.roster?.ids : null;
    const requested = {has: userId => visible.has(userId) || Boolean(rosterIds?.has(userId))};
    function visit(userId) {
      if (jobs.length >= 20) return;
      const config = session.config?.data ?? null;
      const populated = session.roster?.populated?.get(userId);
      const current = session.profiles.get(userId);
      if ((!fresh(current) || current.source === "roster" && populated?.expiresAt > current.expiresAt)
        && fresh(populated) && sufficientProfile(populated.data, config, visible.has(userId))) {
        session.profiles.set(userId, populated); session.revision++;
      }
      const record = session.profiles.get(userId);
      const needsFull = fresh(record) && record.source === "roster" && visible.has(userId)
        && !(record.rowRetryAt > Date.now()) && !sufficientProfile(record.data, config, true);
      if (due(record) || needsFull) addJob(jobs, "user.getUserById", { userId }, value => {
        const record = snapshot(value), user = record.data;
        if (!user || (user._id ?? user.id) !== userId) throw new Error("Player identity mismatch");
        session.profiles.set(userId, record);
      }, () => session.profiles.set(userId, needsFull ? { ...record, rowRetryAt: Date.now() + 30000 } : { ...record, retryAt: Date.now() + 30000 }));
      if (jobs.length < 20 && visible.has(userId) && due(session.equipment.get(userId))) addJob(jobs, "inventory.fetchCurrentEquipment", { userId }, value => {
        const record = snapshot(value);
        if (!record.data || typeof record.data !== "object" || Array.isArray(record.data)) throw new Error("Equipment unavailable");
        session.equipment.set(userId, record);
      }, () => session.equipment.set(userId, { ...session.equipment.get(userId), retryAt: Date.now() + 30000 }));
    }
    // Visible rows retain priority. Rotate through the remaining roster so
    // large scans make progress without sorting thousands of IDs per pump.
    for (const userId of visible) visit(userId);
    if (session.queueRoster !== rosterIds || session.queueSize !== (rosterIds?.size || 0)) {
      session.profileQueue = [...(rosterIds || [])]; session.queueRoster = rosterIds; session.queueSize = rosterIds?.size || 0;
    }
    const roster = session.profileQueue;
    for (let count = 0; count < Math.min(roster.length, 200) && jobs.length < 20; count++) {
      session.profileCursor %= roster.length;
      const userId = roster[session.profileCursor++];
      if (!visible.has(userId)) visit(userId);
    }
    // Row-only browsing retains at most the current viewport. Timeline clients
    // keep the roster, including members not mounted by the game's pagination.
    for (const map of [session.profiles, session.equipment]) for (const userId of map.keys()) if (!requested.has(userId)) map.delete(userId);
    if (!jobs.length) return;
    session.pending = true;
    try {
      const response = await (globalThis.__weAgoApi?.send ?? chrome.runtime.sendMessage)({ type: "WE_AGO_BATCH", options: { settled: true }, calls: jobs.map(job => job.call) });
      if (!live()) return;
      if (!response?.ok || !Array.isArray(response.data) || response.data.length !== jobs.length) throw new Error("Player data unavailable");
      session.error = "";
      for (let i = 0; i < jobs.length; i++) {
        const outcome = response.data[i];
        try {
          if (outcome?.ok === false) jobs[i].fail();
          else jobs[i].apply(outcome?.ok === true ? outcome.result : outcome);
        } catch { jobs[i].fail(); }
      }
    } catch {
      if (!live()) return;
      session.error = t("Data unavailable · check API settings");
      for (const job of jobs) job.fail();
    } finally { session.pending = false; session.revision++; }
  }

  function rowValues(session, userId) {
    const profile = session.profiles.get(userId), equipment = session.equipment.get(userId);
    const user = profile?.data ?? null, gear = equipment?.data ?? null;
    const config = session.config?.data ?? null;
    const resource = key => {
      const skill = user?.skills?.[key], current = skill?.currentBarValue, max = skill?.total;
      const known = finite(current) && finite(max) && current >= 0 && max > 0;
      return { current, max, known, text: known ? `${fmt(current)} / ${fmt(max)}` : "—" };
    };
    const state = pillState(user, config, Date.now());
    const values = [
      { ...resource("health"), resource: "health", title: t("Health") },
      { ...resource("hunger"), resource: "hunger", title: t("Hunger") },
      { text: t`Dmg ≈${compact(damagePotential(user, gear, config, Date.now()))}`,
        title: t("Expected damage now using equipped gear/ammo, current HP and whole cooked-fish portions. Assumes enough food, ammo and replacement gear; excludes battle/order bonuses and enemy defenses.") }
    ];
    if (combatBuild(user) && ["buff", "debuff"].includes(state.kind)) values.push({
      text: `${state.kind === "buff" ? t("Buff") : t("Debuff")} ${clock((state.kind === "buff" ? state.buffEnd : state.debuffEnd) - Date.now())}`,
      kind: state.kind, title: t("Current pill/buff state; timer until this effect ends")
    });
    if (user && (!fresh(profile) || !fresh(equipment) || !fresh(session.config))) {
      for (const value of values) value.title += t(" · Last known");
    }
    return values;
  }
  function renderRows(mounts, session, found) {
    for (const [anchor, mount] of mounts) if (found.get(anchor) !== mount.userId) { mount.node.remove(); mounts.delete(anchor); }
    for (const [anchor, userId] of found) {
      let mount = mounts.get(anchor);
      if (!mount) {
        const node = owned("span", "strip");
        node.setAttribute("role", "group"); node.setAttribute("aria-label", t("Player combat readiness"));
        mount = { node, userId, signature: "" }; mounts.set(anchor, mount);
      }
      if (anchor.nextElementSibling !== mount.node) anchor.insertAdjacentElement("afterend", mount.node);
      const values = rowValues(session, userId), signature = JSON.stringify(values);
      if (signature === mount.signature) continue;
      mount.signature = signature;
      mount.node.replaceChildren(...values.map(value => {
        if (value.resource) {
          const bar = owned("span", "resource");
          bar.dataset.resource = value.resource; bar.dataset.known = String(value.known);
          bar.setAttribute("role", "progressbar"); bar.setAttribute("aria-label", value.title);
          if (value.known) {
            bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", String(value.max));
            bar.setAttribute("aria-valuenow", String(Math.min(value.current, value.max)));
            bar.setAttribute("aria-valuetext", `${fmt(value.current)} of ${fmt(value.max)}`);
          } else bar.setAttribute("aria-valuetext", t("Unavailable"));
          bar.title = value.title;
          const fill = owned("span", "resource-fill");
          fill.style.width = (value.known ? Math.min(100, value.current / value.max * 100) : 0) + "%";
          const label = owned("span", "resource-label");
          const icon = owned("span", "resource-icon", value.resource === "health" ? "♥" : "🍴");
          icon.setAttribute("aria-hidden", "true"); label.append(icon, owned("span", "resource-value", value.text));
          bar.append(fill, label); return bar;
        }
        const node = owned("span", "metric", value.text);
        node.dataset.state = value.kind ?? "neutral"; node.title = value.title;
        return node;
      }));
    }
  }

  function graphAnchor(found) {
    // This is the Citizens/Members disclosure in the user's screenshot. It is
    // extension-owned and can be closed: the chart belongs AFTER it, not inside.
    const info = route();
    const census = document.querySelector(`.we-ago-country-builds-card[data-scope="${info?.kind}"][data-entity-id="${info?.id}"] .we-ago-country-drawer`);
    if (census) return census;
    // Keep the independent graph at the same top-of-content location when
    // the summary is disabled, ahead of Battle orders.
    if (info?.kind === "mu") {
      const section = globalThis.__weAgoCountryBuilds?.findMuTopAnchor();
      if (section) return { node: section, position: "before" };
    }
    const safe = node => {
      const parent = node?.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement || parent.closest(OWNED)) return false;
      const style = getComputedStyle(parent);
      return (["block", "flow-root"].includes(style.display) || style.display === "flex" && style.flexDirection === "column"
        || style.display === "grid" && !style.gridTemplateColumns.trim().includes(" "))
        && !["absolute", "fixed"].includes(style.position) && !["hidden", "clip"].includes(style.overflowY);
    };
    for (const anchor of found.keys()) {
      const list = anchor.closest('table, [role="table"], ul, ol, [role="list"]');
      if (list && !list.closest(OWNED) && safe(list)) return list;
    }
    return [...document.querySelectorAll('h2, h3, h4, [role="heading"]')].find(node =>
      !node.closest(OWNED) && safe(node) && /^(citizens|members)(?:\s*\(?[\d,]+\)?)?$/i.test(node.textContent.trim())) ?? null;
  }
  function svgNode(tag, name, attributes, text) {
    const node = owned(tag, name, text, true);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  }
  function createChart() {
    const node = owned("section", "timeline"), title = owned("strong", "heading", t("Pill timeline · 24h"));
    title.title = t("Existing buff/debuff timers only; no future pill use assumed");
    const legend = owned("div", "legend");
    for (const [kind, label] of [["buff", t("━ Buffed")], ["debuff", t("┅ Debuffed")]]) {
      const item = owned("span", "legend-item", label); item.dataset.state = kind; legend.append(item);
    }
    const svg = svgNode("svg", "chart", { viewBox: "0 0 560 200", role: "img", "aria-label": t("Buffed and debuffed Damage/Hybrid players over the next 24 hours") });
    const input = owned("input", "time-input");
    input.type = "range"; input.min = "0"; input.max = "1440"; input.step = "1"; input.value = "0";
    input.setAttribute("aria-label", t("Inspect minutes from now"));
    const readout = owned("output", "readout"), status = owned("span", "coverage");
    const chart = { node, svg, input, readout, status, signature: "", model: null, now: 0 };
    input.addEventListener("input", () => inspectChart(chart));
    node.append(title, legend, svg, input, readout, status);
    return chart;
  }
  function inspectChart(chart) {
    if (!chart.model?.included) { chart.readout.textContent = ""; return; }
    const at = chart.now + Number(chart.input.value) * 60000;
    let point = chart.model.data[0];
    for (const next of chart.model.data) if (next.at <= at) point = next;
    const date = new Date(at).toLocaleString(globalThis.__weAgoI18n?.locale, { weekday: "short", hour: "2-digit", minute: "2-digit" });
    chart.readout.textContent = t`${date} · Buffed ${point.buff} · Debuffed ${point.debuff}`;
  }
  function renderChart(chart, session) {
    const now = Date.now(), roster = session.roster;
    const stamp = `${Math.floor(now / 60000)}:${session.revision}`;
    if (chart.stamp === stamp && chart.nextChange > now) return;
    const config = session.config?.data ?? null;
    const users = [...(roster?.ids ?? [])].flatMap(id => session.profiles.get(id)?.data ? [session.profiles.get(id).data] : []);
    const model = population(users, config, now);
    const eligible = users.filter(combatBuild).length;
    const current = model.data[0];
    const coverage = roster?.ids.size ?? 0;
    const stale = roster && !roster.loading && !fresh(roster) || users.some(user => !fresh(session.profiles.get(user._id))) || session.config?.data && !fresh(session.config);
    const status = session.error || (roster?.loading ? t`Loading members · ${coverage} found` : stale ? t("Last known · refreshing") : "");
    chart.status.textContent = t`${model.included}/${eligible} Damage/Hybrid${roster?.partial || roster?.loading || stale || model.included < eligible || users.length < coverage || users.some(user => buildKind(user) === null) ? t(" · Partial") : ""}${status ? " · " + status : ""}`;
    chart.input.disabled = !model.included;
    chart.stamp = stamp;
    // Freshness expires independently of the timers and minute labels.
    chart.nextChange = Math.min(model.data[1]?.at ?? Infinity, ...[...users.map(user => session.profiles.get(user._id)?.expiresAt),
      session.config?.expiresAt, roster?.expiresAt].filter(at => at > now));
    chart.now = now; chart.model = model;
    const nodes = [], width = 500, height = 150, max = Math.max(1, model.included);
    const x = at => 40 + (at - now) / (24 * HOUR) * width, y = count => 165 - count / max * height;
    for (const count of new Set([0, Math.floor(max / 2), max])) {
      nodes.push(svgNode("path", "grid", { d: `M40 ${y(count)}H540` }));
      nodes.push(svgNode("text", "axis", { x: 34, y: y(count) + 4, "text-anchor": "end" }, String(count)));
    }
    for (const hours of [0, 6, 12, 18, 24]) {
      const at = now + hours * HOUR;
      nodes.push(svgNode("text", "axis", { x: x(at), y: 190, "text-anchor": "middle" },
        new Date(at).toLocaleTimeString(globalThis.__weAgoI18n?.locale, { hour: "2-digit", minute: "2-digit" })));
    }
    for (const kind of ["buff", "debuff"]) {
      let path = "", previous;
      for (const point of model.data) {
        path += previous ? `H${x(point.at)}V${y(point[kind])}` : `M${x(point.at)} ${y(point[kind])}`;
        previous = point;
      }
      const line = svgNode("path", "line", { d: model.included ? path : "" });
      line.dataset.state = kind; nodes.push(line);
    }
    chart.svg.replaceChildren(...nodes);
    chart.svg.setAttribute("aria-label", t`${model.included} Damage/Hybrid players: ${current.buff} buffed, ${current.debuff} debuffed now. Local time; next 24 hours.`);
    inspectChart(chart);
  }

  function create(mode) {
    const owner = { mode }, mounts = new Map();
    let stopped = false, session, chart, fallback;
    let found = new Map();
    function clear() {
      for (const mount of mounts.values()) mount.node.remove();
      mounts.clear(); chart?.node.remove(); fallback?.remove(); chart = fallback = undefined;
      found = new Map();
      release(session, owner); session = undefined;
    }
    function sync({ discover = true, shared } = {}) {
      if (stopped) return;
      const info = route();
      if (!info || mode === "timeline" && !["mu", "country"].includes(info.kind)) { clear(); return; }
      if (session?.info.key !== info.key) { clear(); session = acquire(info, owner); discover = true; }
      if (document.hidden) return;
      if (discover) {
        if (shared?.has("spy-targets")) found = shared.get("spy-targets");
        else { found = targets(); shared?.set("spy-targets", found); }
      }
      // A detached row is never kept alive until the next observer delivery.
      if ([...found.keys()].some(anchor => !anchor.isConnected)) found = new Map([...found].filter(([anchor]) => anchor.isConnected));
      if (mode === "rows") renderRows(mounts, session, found);
      else {
        chart ??= createChart();
        const anchor = discover || !chart.node.isConnected ? graphAnchor(found) : null;
        if (anchor) {
          if (anchor.position === "before") {
            if (chart.node.nextElementSibling !== anchor.node) anchor.node.before(chart.node);
          } else if (anchor.nextElementSibling !== chart.node) anchor.insertAdjacentElement("afterend", chart.node);
          fallback?.remove();
        } else if ((discover || !chart.node.isConnected) && document.body) {
          if (!fallback) {
            fallback = owned("details", "fallback");
            fallback.setAttribute("name", "we-ago-floating");
            fallback.open = false;
            fallback.style.setProperty("position", "fixed", "important");
            fallback.append(owned("summary", "fallback-toggle", t("Pill timeline")));
          }
          if (chart.node.parentElement !== fallback) fallback.append(chart.node);
          if (fallback.parentElement !== document.body) document.body.append(fallback);
        }
        renderChart(chart, session);
      }
      if (found.size || has(session, "timeline")) void pump(session, found);
    }
    return { sync, tick() { sync({ discover: false }); }, destroy() { stopped = true; clear(); } };
  }
  globalThis.__weAgoSpyXray = { create: () => create("rows") };
  globalThis.__weAgoPillTimeline = { create: () => create("timeline") };
})();
