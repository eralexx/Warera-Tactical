"use strict";

// Observe successful responses already received by the game. Never make or replay a
// request, inspect headers, or expose credentials across the world boundary.
(() => {
  const channel = "we-ago-battle-read-v1", saved = new Map();
  let enabled = false, generation = 0;
  const combatChannel = "we-ago-combat-read-v1";
  let combatEnabled = false, combatGeneration = 0;
  const contractChannel = "we-ago-contract-read-v1";
  let contractEnabled = false, contractGeneration = 0;
  const warmPolicy = globalThis.__weAgoPassiveCache;
  let warmEnabled = false, warmGeneration = 0;
  const id = value => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
  const unwrap = value => value && Object.hasOwn(value, "json") ? value.json : value;
  const emit = record => window.postMessage({ channel, record }, location.origin);
  function accept(procedure, input, data) {
    input = unwrap(input); data = unwrap(data);
    let record, key;
    if (procedure === "mercenaryContract.getContracts" && id(input?.battleId) && id(input.countryId)
      && input.status === "active" && !input.cursor && Array.isArray(data?.items)) {
      const items = data.items.slice(0, 50).map(c => ({ _id: c._id, battle: c.battle,
        forCountrySide: c.forCountrySide, status: c.status, minimumDamage: c.minimumDamage, currentDamages: c.currentDamages }));
      record = { kind: "contracts", battleId: input.battleId, countryId: input.countryId, items,
        partial: Boolean(data.nextCursor) || items.length >= (input.limit || 50) };
      key = `contracts:${input.battleId}:${input.countryId}`;
    } else if (["user.getUserLite", "user.getUserById"].includes(procedure) && id(input?.userId) && data?._id === input.userId && Object.hasOwn(data, "buffs")) {
      record = { kind: "profile", userId: data._id, buffs: data.buffs === null ? null : {
        buffCodes: Array.isArray(data.buffs?.buffCodes) ? data.buffs.buffCodes.filter(c => typeof c === "string").slice(0, 30) : undefined,
        buffEndAt: data.buffs?.buffEndAt,
        debuffCodes: Array.isArray(data.buffs?.debuffCodes) ? data.buffs.debuffCodes.filter(c => typeof c === "string").slice(0, 30) : undefined,
        debuffEndAt: data.buffs?.debuffEndAt } };
      key = `profile:${data._id}`;
    } else if (["round.getRoundData", "round.getById"].includes(procedure)) {
      const round = data?.round ?? data;
      if (!id(round?._id) || !id(round.battle) || typeof round.isActive !== "boolean") return;
      record = { kind: "round", roundId: round._id, battleId: round.battle, active: round.isActive,
        defenderCountry: round.defender?.country, attackerCountry: round.attacker?.country };
      key = `round:${round.battle}`;
    }
    if (!record) return;
    record.receivedAt = Date.now();
    saved.delete(key); saved.set(key, record);
    while (saved.size > 2000) saved.delete(saved.keys().next().value);
    emit(record);
  }
  const original = window.fetch;
  window.fetch = function (...args) {
    const promise = Reflect.apply(original, this, args);
    if (!enabled && !combatEnabled && !warmEnabled && !contractEnabled) return promise;
    const revision = generation;
    const combatRevision = combatGeneration;
    const warmRevision = warmGeneration;
    const contractRevision = contractGeneration;
    const observingContract = contractEnabled;
    const observingWarm = warmEnabled;
    try {
      const request = args[0], options = args[1];
      const url = new URL(typeof request === "string" || request instanceof URL ? request : request.url, location.href);
      if (!/^https:\/\/api\d+\.warera\.io$/.test(url.origin) || !url.pathname.startsWith("/trpc/")) return promise;
      const method = String(options?.method || (request instanceof Request ? request.method : "GET")).toUpperCase();
      const combatRead = procedure => ["inventory.fetchCurrentEquipment", "inventory.equippedItems", "user.getMe", "user.getUserLite", "user.getUserById"].includes(procedure)
        || method !== "GET" && procedure.startsWith("inventory.");
      // Passive api4 reads are native game traffic, never extension requests.
      const canWarm = observingWarm && method === "GET" && ["https://api2.warera.io", "https://api4.warera.io", "https://api5.warera.io"].includes(url.origin);
      const procedures = decodeURIComponent(url.pathname.slice(6)).split(",");
      const contractRead = p => observingContract && p === "mercenaryContract.getActiveForBattle";
      if (!procedures.some(p => canWarm && warmPolicy.procedures.includes(p)
        || contractRead(p)
        || enabled && ["mercenaryContract.getContracts", "user.getUserLite", "user.getUserById", "round.getRoundData", "round.getById"].includes(p)
        || combatEnabled && combatRead(p))) return promise;
      const inputs = url.searchParams.get("input") ?? options?.body ?? (request instanceof Request ? request.clone().text() : "{}");
      const interested = () => enabled && generation === revision || combatEnabled && combatGeneration === combatRevision || canWarm && warmEnabled && warmGeneration === warmRevision
        || observingContract && contractEnabled && contractGeneration === contractRevision;
      // Clone in the first fetch reaction, before the game's own continuation
      // can consume the original body. Awaiting Promise.all first loses that race.
      const snapshot = promise.then(response => response.ok && interested()
        ? { response: response.clone(), receivedAt: Date.now() } : null);
      void Promise.all([snapshot, Promise.resolve(inputs)]).then(async ([observed, raw]) => {
        if (!observed || !interested()) return;
        const receivedAt = observed.receivedAt;
        const input = JSON.parse(raw), payload = await observed.response.json();
        const batch = url.searchParams.get("batch") === "1";
        const envelopes = batch ? payload : [payload];
        if (!Array.isArray(envelopes)) return;
        procedures.forEach((procedure, index) => {
          const envelope = envelopes[index];
          if (!envelope?.result || !Object.hasOwn(envelope.result, "data")) return;
          const args = unwrap(batch ? input[index] : input), data = unwrap(envelope.result.data);
          if (contractRead(procedure) && contractEnabled && contractGeneration === contractRevision
            && id(args?.battleId) && id(args.muId) && (data === null || data && typeof data === "object")) {
            const contract = data === null ? null : Object.fromEntries(
              ["battle", "mu", "status", "forCountrySide", "moneyPer1kDamages", "perK", "minimumDamage", "currentDamages", "expiresAt"]
                .map(key => [key, ["mu", "battle"].includes(key) && typeof data[key] === "object" ? data[key]?._id : data[key]])
                .filter(([, value]) => value === null || ["string", "number"].includes(typeof value)));
            window.postMessage({ channel: contractChannel, record: { battleId: args.battleId, muId: args.muId, contract, receivedAt } }, location.origin);
          }
          if (canWarm && warmEnabled && warmGeneration === warmRevision) {
            const record = { procedure, input: args ?? {}, data, receivedAt, provider: url.hostname === "api5.warera.io" ? "official5" : "official" };
            if (warmPolicy.valid(record)) window.postMessage({ channel: warmPolicy.channel, record }, location.origin);
          }
          if (enabled && generation === revision) accept(procedure, args, data);
          if (combatEnabled && combatGeneration === combatRevision && combatRead(procedure)) {
            // Only a bounded change signature crosses worlds, never request
            // headers, inventory contents, credentials or mutation arguments.
            let signature;
            if (["inventory.fetchCurrentEquipment", "inventory.equippedItems"].includes(procedure) && data && typeof data === "object") {
              signature = JSON.stringify([data.ammo, data.ammoQuantity, ...["weapon", "helmet", "chest", "pants", "gloves", "boots"].map(slot => {
                const item = data[slot];
                return item ? [item._id, item.code, item.state, ...["attack", "precision", "criticalChance", "criticalDamages", "armor", "dodge"].map(key => item.skills?.[key])] : null;
              })]);
            } else if (procedure.startsWith("user.")) signature = JSON.stringify([data?.buffs?.buffCodes, data?.buffs?.debuffCodes,
              data?.buffs?.buffEndAt, data?.buffs?.debuffEndAt, data?.skills?.attack?.buffsPercent, data?.skills?.attack?.debuffsPercent]);
            window.postMessage({ channel: combatChannel, record: { kind: "loadout", procedure, userId: id(args?.userId) ? args.userId : undefined,
              signature: typeof signature === "string" ? signature.slice(0, 3000) : undefined, receivedAt: Date.now() } }, location.origin);
          }
        });
      }).catch(() => {});
    } catch { /* Observation must never affect the game's fetch. */ }
    return promise;
  };
  window.addEventListener("message", event => {
    if (event.source === window && event.origin === location.origin && event.data?.channel === contractChannel && typeof event.data.subscribe === "boolean") {
      contractEnabled = event.data.subscribe; contractGeneration++;
    }
    if (event.source === window && event.origin === location.origin && event.data?.channel === warmPolicy?.channel && typeof event.data.subscribe === "boolean") {
      warmEnabled = event.data.subscribe; warmGeneration++;
    }
    if (event.source === window && event.origin === location.origin && event.data?.channel === combatChannel && typeof event.data.subscribe === "boolean") {
      combatEnabled = event.data.subscribe; combatGeneration++;
    }
    if (event.source === window && event.origin === location.origin && event.data?.channel === channel) {
      if (typeof event.data.subscribe === "boolean") { enabled = event.data.subscribe; generation++; if (!enabled) saved.clear(); }
      if (!enabled || !event.data.ready) return;
      for (const record of saved.values()) if (Date.now() - record.receivedAt < 120000) emit(record);
    }
  });
})();
