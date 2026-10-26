"use strict";

(() => {
  const t = (source = "", ...values) => globalThis.__weAgoI18n?.t(source, ...values)
    ?? (typeof source === "string" ? source : source.reduce((text, part, i) => text + part + (i < values.length ? values[i] : ""), ""));

  const SIDES = ["defender", "attacker"];
  const isId = value => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
  const unwrap = value => value && Object.hasOwn(value, "json") ? value.json : value;
  const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
  // Worker responses and progressive snapshots can omit collection fields.
  // Normalize them before selecting records; never call methods on payloads.
  function select(values, predicate) {
    const selected = [];
    if (Array.isArray(values)) for (const value of values) if (predicate(value)) selected.push(value);
    return selected;
  }
  const observed = new Map();
  const observe = event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== "we-ago-battle-read-v1") return;
    const record = event.data.record;
    if (!record || !["contracts", "profile", "round"].includes(record.kind) || !Number.isFinite(record.receivedAt)
      || record.receivedAt > Date.now() || Date.now() - record.receivedAt >= 120000) return;
    const key = record.kind === "profile" ? `profile:${record.userId}` : record.kind === "round" ? `round:${record.battleId}` : `contracts:${record.battleId}:${record.countryId}`;
    observed.delete(key); observed.set(key, record);
    while (observed.size > 2000) observed.delete(observed.keys().next().value);
  };
  let subscribers = 0;
  function startObservation() {
    if (subscribers++ === 0) {
      window.addEventListener("message", observe);
      window.postMessage({ channel: "we-ago-battle-read-v1", subscribe: true, ready: true }, location.origin);
    }
    let released = false;
    return () => {
      if (released) return; released = true;
      if (--subscribers === 0) {
        window.removeEventListener?.("message", observe); observed.clear();
        window.postMessage({ channel: "we-ago-battle-read-v1", subscribe: false }, location.origin);
      }
    };
  }
  function fresh(key, ttl = 120000) {
    const record = observed.get(key);
    return record && Date.now() - record.receivedAt < ttl ? record : null;
  }
  function observedContracts(battleId, countryId, side) {
    const record = fresh(`contracts:${battleId}:${countryId}`, 120000);
    if (!record || !Array.isArray(record.items)) return null;
    const unique = new Set();
    let remaining = 0;
    for (const contract of record.items) {
      if (contract?.battle !== battleId || contract.forCountrySide !== side || unique.has(contract._id)) continue;
      if (!isId(contract._id)) return null;
      try { remaining += contractRemaining(contract, battleId, side); } catch { return null; }
      unique.add(contract._id);
    }
    return { remaining, partial: record.partial === true, expiresAt: record.receivedAt + 120000 };
  }
  const fmt = value => number(value) ? value.toLocaleString(globalThis.__weAgoI18n?.locale || "en-US", { notation: "compact", maximumFractionDigits: 1 }) : "—";
  const time = value => number(value) ? `${Math.floor(value / 60000)}m ${Math.floor(value % 60000 / 1000)}s` : "—";
  function route() {
    const url = new URL(location.href);
    const match = /^\/battle\/([a-f\d]{24})\/?$/i.exec(url.pathname);
    const selected = url.searchParams.get("round");
    if (!match || selected !== null && !/^[1-9]\d?$/.test(selected)) return null;
    return { battleId: match[1], roundNumber: selected === null ? undefined : Number(selected), key: url.href };
  }
  function owned(tag, name, text) {
    const node = document.createElement(tag);
    node.className = "we-ago-battle-" + name;
    node.dataset.weAgo = "true";
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function write(node, text) { if (node.textContent !== text) node.textContent = text; }

  // Public profile buffs describe current effects, not historical consumptions.
  function pills(profiles, now) {
    let known = 0, count = 0, debuffed = 0;
    const ends = [];
    for (const profile of profiles) {
      const buffs = profile?.buffs;
      if (buffs === null) { known++; continue; }
      if (!Array.isArray(buffs?.buffCodes) && !Array.isArray(buffs?.debuffCodes)) continue;
      // Profile buff/debuff lists describe current pill state. Effect
      // codes need not be named "pill", and several effects still mean one user.
      const codes = select(buffs.buffCodes, code => typeof code === "string" && code.length);
      const end = Date.parse(buffs.buffEndAt);
      if (codes.length && !Number.isFinite(end)) continue;
      known++;
      if (buffs.debuffCodes?.length && Date.parse(buffs.debuffEndAt) > now) debuffed++;
      if (!codes.length || end <= now) continue;
      count++;
      ends.push(end);
    }
    return { known, count, ends, debuffed };
  }
  function bounty(side, now) {
    if (!number(side?.moneyPool)) return NaN;
    if (side.moneyPool === 0) return 0;
    if (!number(side.moneyPer1kDamages) || side.moneyPer1kDamages === 0) return NaN;
    if (side.bountyEffectiveAt && Date.parse(side.bountyEffectiveAt) > now) return 0;
    return side.moneyPool / side.moneyPer1kDamages * 1000;
  }

  function contractRemaining(contract, battleId, side) {
    if (!contract || contract.battle !== battleId || contract.forCountrySide !== side) throw new Error("Contract identity mismatch");
    if (contract.status !== "active") return 0;
    if (!number(contract.minimumDamage) || !number(contract.currentDamages)) throw new Error("Missing contract progress");
    return Math.max(0, contract.minimumDamage - contract.currentDamages);
  }

  function create() {
    const stopObservation = startObservation();
    let stopped = false, pending = false, generation = 0, key = "", nextFetch = 0;
    let panel, cells, snapshot;
    function remove() { panel?.remove(); panel = cells = undefined; }
    function mount() {
      const d = document.getElementById("defender-round-bar"), a = document.getElementById("attacker-round-bar");
      if (!d?.getClientRects().length || !a?.getClientRects().length) { remove(); return false; }
      let row = d.parentElement;
      while (row && !row.contains(a)) row = row.parentElement;
      if (!row || row === document.body || row === document.documentElement || row.parentElement === document.body) { remove(); return false; }
      if (!panel) {
        const legacy = document.getElementById("we-ago-battle-panel");
        if (legacy?.dataset.weAgo === "true") legacy.remove();
        panel = owned("table", "panel");
        panel.id = "we-ago-battle-panel";
        panel.setAttribute("aria-label", t("Battle resources"));
        const body = owned("tbody", "body");
        cells = {};
        for (const [metric, label] of [["pills", t("Pills active")], ["time", t("Avg pill time")], ["contracts", t("Contract damage left")], ["bounty", t("Bounty damage left")]]) {
          const tr = owned("tr", "row"), th = owned("th", "label", label);
          th.scope = "row"; cells[metric] = {};
          for (const side of SIDES) {
            const td = owned("td", "value", "—");
            td.dataset.side = side;
            td.setAttribute("aria-label", `${t(side)}: ${label}`);
            cells[metric][side] = td;
          }
          tr.append(cells[metric].defender, th, cells[metric].attacker);
          body.append(tr);
        }
        panel.append(body);
      }
      if (row.nextElementSibling !== panel) row.insertAdjacentElement("afterend", panel);
      return true;
    }
    function render() {
      if (!cells) return;
      const now = Date.now();
      const info = route();
      const nativeRound = info && fresh(`round:${info.battleId}`);
      for (const side of SIDES) {
        // Two absent round IDs compare equal; that is not a native round.
        const active = nativeRound && isId(nativeRound.roundId) && nativeRound.roundId === snapshot?.roundId
          ? nativeRound?.active === true : snapshot?.active === true;
        const data = active ? snapshot?.sides?.[side] : null;
        const liveProfiles = select(data?.profiles, record => record?.data && typeof record.data === "object").map(record => {
          const native = fresh(`profile:${record.data?._id}`);
          return native ? { ...record.data, buffs: native.buffs } : record.data;
        }) || [];
        const metrics = pills(liveProfiles, now);
        const activeEnds = metrics.ends;
        const coverage = data ? t`${metrics.known}/${data.total} profiles; ${metrics.debuffed} debuffed${data.truncated ? t("; ranking truncated") : ""}${liveProfiles.length > metrics.known ? t("; API omitted buff data") : ""}${snapshot.errors?.[side] ? "; " + snapshot.errors[side] : ""}`
          : snapshot?.errors?.[side] || t("Loading profiles");
        const totalKnown = Number.isInteger(data?.total) && data.total >= 0;
        const partial = data && (!totalKnown || metrics.known < data.total || data.truncated);
        write(cells.pills[side], data && (metrics.known || totalKnown && data.total === 0) ? `${partial ? "≥" : ""}${activeEnds.length}` : "—");
        write(cells.time[side], activeEnds.length ? `${partial ? "~" : ""}${time(activeEnds.reduce((sum, end) => sum + end - now, 0) / activeEnds.length)}` : "—");
        const age = data && (data.expiresAt <= now || data.profiles?.some?.(record => record?.expiresAt <= now)) ? t(" · Last known") : "";
        cells.pills[side].title = coverage + age;
        cells.time[side].title = coverage + age;
        write(cells.bounty[side], fmt(snapshot?.battle ? bounty(snapshot.battle[side], now) : NaN));
        cells.bounty[side].title = t("Remaining bounty pool ÷ payout per 1,000 damage") + (snapshot?.battleExpiresAt <= now ? t(" · Last known") : "");
        const countryId = nativeRound?.[side + "Country"] ?? snapshot?.battle?.[side]?.country;
        const contracts = info && observedContracts(info.battleId, countryId, side) || snapshot?.contracts?.[side];
        write(cells.contracts[side], contracts ? `${contracts.partial ? "≥" : ""}${fmt(contracts.remaining)}` : "—");
        cells.contracts[side].title = contracts ? t("Remaining damage in active contracts") + (contracts.expiresAt <= now ? t(" · Last known") : "") : snapshot?.errors?.["contracts-" + side] || t("Waiting for the game's contract response");
      }
    }
    async function query(procedure, input, ttlSeconds = 120) {
      const response = await (globalThis.__weAgoApi?.send ?? chrome.runtime.sendMessage)({ type: "WE_AGO_QUERY", procedure, input, options: { ttlSeconds } });
      if (!response?.ok) throw new Error(response?.error?.message || "Request failed");
      const result = response.data;
      if (!Number.isFinite(result?.createdAt) || !Number.isFinite(result.expiresAt)) throw new Error("Missing cache metadata");
      return { data: unwrap(result.data), expiresAt: Math.min(result.expiresAt, result.createdAt + ttlSeconds * 1000) };
    }
    async function dealers(roundId, side, valid) {
      if (!isId(roundId)) throw new Error("Round data unavailable");
      const ids = new Set(), cursors = new Set();
      let cursor, expiresAt = Infinity, truncated = false;
      for (let page = 0; page < 10 && valid(); page++) {
        const input = { roundId, dataType: "damage", type: "user", side, limit: 100 };
        if (cursor) input.cursor = cursor;
        const result = await query("battleRanking.getRanking", input);
        if (!valid()) return null;
        // Current game responses paginate ranking documents in `items`;
        // older public clients returned player IDs directly in `rankings`.
        const current = Array.isArray(result.data?.items);
        const entries = current ? result.data.items : result.data?.rankings;
        if (!Array.isArray(entries)) throw new Error("Ranking response has neither items nor rankings");
        expiresAt = Math.min(expiresAt, result.expiresAt);
        for (const entry of entries) {
          if (!entry || typeof entry !== "object") continue;
          // In `items`, _id identifies the ranking record, not its player.
          const id = typeof entry.user === "object" ? entry.user?._id : entry.user ?? entry.userId ?? entry.entityId ?? (!current ? entry._id : undefined);
          if (isId(id) && number(entry.value) && entry.value > 0) ids.add(id);
        }
        cursor = result.data.nextCursor;
        if (!cursor) {
          truncated = Number.isInteger(result.data.itemCount) ? result.data.itemCount > ids.size : entries.length >= 100;
          break;
        }
        if (cursors.has(cursor)) { truncated = true; break; }
        cursors.add(cursor); truncated = page === 9;
      }
      return { ids: [...ids], expiresAt, truncated };
    }
    async function contractsForSide(battleId, countryId, side, valid) {
      if (!isId(countryId)) throw new Error("Missing side country");
      if (!valid()) return null;
      const result = observedContracts(battleId, countryId, side);
      if (!result) throw new Error(t("Waiting for the game's contract response; this read is absent from the public API"));
      return result;
    }
    async function load(info) {
      pending = true;
      const revision = generation;
      const valid = () => !stopped && !document.hidden && revision === generation && route()?.key === info.key;
      try {
        const liveInput = { battleId: info.battleId };
        if (info.roundNumber !== undefined) liveInput.roundNumber = info.roundNumber;
        const [live, battleResult] = await Promise.allSettled([
          query("battle.getLiveBattleData", liveInput), query("battle.getById", { battleId: info.battleId })
        ]);
        if (!valid()) return;
        const battle = battleResult.status === "fulfilled" ? battleResult.value.data : snapshot?.battle ?? {};
        if (battle._id !== undefined && battle._id !== info.battleId) throw new Error("Wrong battle");
        let round = live.status === "fulfilled" ? live.value.data?.round : null;
        // Public round summaries and populated currentRound documents use
        // different ID fields. Resolve the selected round without making the
        // independent contract/bounty rows depend on live-summary availability.
        const selectedRound = info.roundNumber === undefined ? battle.currentRound : battle.rounds?.[info.roundNumber - 1];
        const roundId = round?.roundId ?? round?._id ?? (typeof selectedRound === "string" ? selectedRound : selectedRound?._id) ?? snapshot?.roundId;
        if (isId(roundId) && typeof round?.isActive !== "boolean") {
          try {
            const result = await query("round.getById", { roundId });
            if (!valid()) return;
            const roundDocument = result.data?.round ?? result.data;
            if ((roundDocument?._id ?? roundDocument?.roundId) === roundId && (roundDocument.battle ?? roundDocument.battleId ?? info.battleId) === info.battleId) round = roundDocument;
          } catch { /* The other metrics can still render independently. */ }
        }
        const old = snapshot?.roundId === roundId ? snapshot : null;
        snapshot = { roundId, battle, battleExpiresAt: battleResult.status === "fulfilled" ? battleResult.value.expiresAt : old?.battleExpiresAt ?? 0,
          sides: old?.sides || {}, contracts: old?.contracts || {}, errors: {},
          active: (typeof round?.isActive === "boolean" ? round.isActive : old?.active === true) && battle.isActive !== false };
        render();
        // Publish independent contract results as soon as they arrive. A long
        // profile scan must not hold them until their 30-second cache expires.
        const contractsTask = Promise.allSettled(SIDES.map(side => contractsForSide(info.battleId, battle[side]?.country, side, valid))).then(results => {
          if (!valid()) return;
          results.forEach((result, index) => {
            const side = SIDES[index];
            if (result.status === "fulfilled" && result.value) snapshot.contracts[side] = result.value;
            else snapshot.errors["contracts-" + side] = result.reason?.message || "Contracts unavailable";
          });
          render();
        });
        const rankings = await Promise.allSettled(SIDES.map(side => dealers(roundId, side, valid)));
        if (!valid()) return;
        const ids = [...new Set(rankings.flatMap(result => result.status === "fulfilled" ? result.value?.ids || [] : []))];
        const profiles = new Map(SIDES.flatMap(side => select(old?.sides?.[side]?.profiles, record => record?.data?._id ?? record?.data?.id).map(record => [record.data._id ?? record.data.id, record])));
        const profileErrors = new Map();
        const publishProfiles = () => {
          if (!valid()) return;
          rankings.forEach((result, index) => {
            const side = SIDES[index];
            if (result.status !== "fulfilled" || !result.value) {
              snapshot.errors[side] = result.reason?.message || "Rankings unavailable";
              return;
            }
            const ranking = result.value;
            const error = ranking.ids.map(id => profileErrors.get(id)).find(Boolean);
            if (error) snapshot.errors[side] = error;
            snapshot.sides[side] = { profiles: select(ranking.ids.map(id => profiles.get(id)), Boolean),
              total: ranking.ids.length, truncated: ranking.truncated, expiresAt: ranking.expiresAt };
          });
          render();
        };
        publishProfiles();
        // Settled reads retain healthy profiles without retrying a failed
        // batch as twenty singleton calls (especially during shared outages).
        for (let offset = 0; offset < ids.length && valid(); offset += 20) {
          const batch = ids.slice(offset, offset + 20);
          let results;
          try {
            const response = await (globalThis.__weAgoApi?.send ?? chrome.runtime.sendMessage)({ type: "WE_AGO_BATCH", options: { settled: true }, calls: batch.map(userId => ({ procedure: "user.getUserById", input: { userId }, ttlSeconds: 120 })) });
            if (!response?.ok || !Array.isArray(response.data) || response.data.length !== batch.length) throw new Error(response?.error?.message || "Profile batch failed");
            results = response.data.map(entry => {
              if (entry?.ok === false) return { status: "rejected", reason: entry.error };
              const result = entry?.ok === true ? entry.result : entry;
              return { status: "fulfilled", value: { data: unwrap(result?.data), expiresAt: Math.min(result?.expiresAt, result?.createdAt + 120000) } };
            });
          } catch (error) {
            results = batch.map(() => ({ status: "rejected", reason: error }));
          }
          if (!valid()) return;
          results.forEach((result, index) => {
            if (result.status !== "fulfilled" || !Number.isFinite(result.value.expiresAt)) {
              profileErrors.set(batch[index], result.reason?.message || "Invalid profile cache metadata");
              return;
            }
            const profile = result.value.data;
            if ((profile?._id ?? profile?.id) !== batch[index]) return;
            profiles.set(batch[index], { data: profile, expiresAt: result.value.expiresAt });
          });
          publishProfiles();
        }
        if (!valid()) return;
        publishProfiles();
        await contractsTask;
        if (!valid()) return;
        const expiries = select([snapshot.battleExpiresAt, ...SIDES.map(side => snapshot.sides[side]?.expiresAt),
          ...SIDES.map(side => snapshot.contracts[side]?.expiresAt)], Number.isFinite);
        nextFetch = Math.max(Date.now() + 5000, Math.min(Date.now() + 30000, ...expiries));
      } catch { if (valid()) { nextFetch = Date.now() + 30000; } }
      finally { pending = false; if (!stopped) sync(); }
    }
    function sync({ discover = true } = {}) {
      if (stopped) return;
      const info = route();
      if ((info?.key || "") !== key) { key = info?.key || ""; generation++; snapshot = undefined; nextFetch = 0; remove(); }
      if (!info) { remove(); return; }
      if (document.hidden) return;
      if ((discover || !panel?.isConnected) && !mount()) return;
      render();
      if (!pending && Date.now() >= nextFetch) void load(info);
    }
    return { sync, tick() { sync({ discover: false }); }, destroy() { stopped = true; stopObservation(); generation++; snapshot = undefined; remove(); } };
  }
  globalThis.__weAgoBattle = { create };
})();
