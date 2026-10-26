"use strict";

// T009: radar uses the shared authenticated GET/cache client and transport.
const RADAR_SETTINGS_KEY = "we-ago:radar";
const RADAR_ALARM = "we-ago-radar-poll";
const RADAR_DEFAULTS = Object.freeze({ minimumBounty: 1, notifyBounty: false, minimumDamageBonus: 0 });
const RADAR_TRACKING_KEY = "we-ago:radarTracking";
const radarUnwrap = value => value && Object.hasOwn(value, "json") ? value.json : value;
const radarId = value => typeof value === "string" ? value : value?._id ?? value?.id;
const radarNumber = (...values) => values.find(value => typeof value === "number" && Number.isFinite(value));

async function readRadarSettings() {
  const [values, features] = await Promise.all([chrome.storage.local.get(RADAR_SETTINGS_KEY), readFeatures()]);
  const stored = values[RADAR_SETTINGS_KEY];
  return {
    enabled: features.bountyRadar,
    contractsEnabled: features.contractRadar,
    minimumBounty: Number.isFinite(stored?.minimumBounty) && stored.minimumBounty >= 0 ? stored.minimumBounty : RADAR_DEFAULTS.minimumBounty,
    notifyBounty: stored?.notifyBounty === true,
    minimumDamageBonus: Number.isFinite(stored?.minimumDamageBonus) ? stored.minimumDamageBonus : 0
  };
}

async function broadcastRadar(message, check = () => {}) {
  const tabs = await chrome.tabs.query({ url: ["https://app.warera.io/*", "https://warera.io/*"] });
  check();
  await Promise.allSettled(tabs.filter(tab => Number.isInteger(tab.id)).map(tab => chrome.tabs.sendMessage(tab.id, message)));
}

async function publishRadar(activeAlerts, lastRadarSync = Date.now(), issue = "", check = () => {}) {
  check();
  await chrome.storage.local.set({ activeAlerts, lastRadarSync, radarIssue: issue });
  const tracking = await readRadarTracking();
  await broadcastRadar({ type: "WE_AGO_RADAR_UPDATE", payload: visibleRadarAlerts(activeAlerts, tracking, await readRadarSettings()), issue, syncedAt: lastRadarSync }, check);
}

const radarValidId = id => typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id);

async function readRadarTracking() {
  const stored = (await chrome.storage.local.get(RADAR_TRACKING_KEY))[RADAR_TRACKING_KEY];
  const ids = value => Array.isArray(value) ? [...new Set(value.filter(radarValidId))] : [];
  return { removedBattleIds: ids(stored?.removedBattleIds), open: stored?.open === true };
}

function visibleRadarAlerts(alerts, tracking, settings) {
  return alerts.filter(alert => ["HIGH_BOUNTY", "CONTRACT"].includes(alert.type) && !tracking.removedBattleIds.includes(alert.battleId)
    && (!settings || (alert.type === "CONTRACT" ? settings.contractsEnabled : settings.enabled)));
}

async function broadcastRadarState() {
  await broadcastRadar({ type: "WE_AGO_RADAR_STATE", settings: await readRadarSettings(), tracking: await readRadarTracking() });
}

async function saveRadarTracking(message) {
  const tracking = await readRadarTracking();
  const settings = await readRadarSettings();
  const id = message.battleId;
  switch (message.action) {
    case "remove": {
      if (!radarValidId(id)) throw failure("INVALID_RADAR", "Invalid battle preference.");
      tracking.removedBattleIds = [...new Set([...tracking.removedBattleIds, id])];
      break;
    }
    case "restore": tracking.removedBattleIds = []; break;
    case "open":
      if (typeof message.open !== "boolean") throw failure("INVALID_RADAR", "Invalid dropdown state.");
      tracking.open = message.open;
      break;
    case "rules":
      if (typeof message.notifyBounty !== "boolean" || !Number.isFinite(message.minimumBounty) || message.minimumBounty < 0
        || !Number.isFinite(message.minimumDamageBonus)) throw failure("INVALID_RADAR", "Enter a nonnegative bounty and a valid damage bonus.");
      Object.assign(settings, { notifyBounty: message.notifyBounty, minimumBounty: message.minimumBounty, minimumDamageBonus: message.minimumDamageBonus });
      await chrome.storage.local.set({ [RADAR_SETTINGS_KEY]: settings });
      break;
    default: throw failure("INVALID_RADAR", "Unknown radar control.");
  }
  await chrome.storage.local.set({ [RADAR_TRACKING_KEY]: tracking });
  await broadcastRadarState();
  const snapshot = await chrome.storage.local.get(["activeAlerts", "lastRadarSync"]);
  if (snapshot.lastRadarSync > Date.now() - 120000) {
    const alerts = snapshot.activeAlerts || [];
    await broadcastRadar({ type: "WE_AGO_RADAR_UPDATE", payload: visibleRadarAlerts(alerts, tracking, settings) });
    if (message.action === "rules") await notifyRadar(alerts, settings);
  }
  if (message.action === "rules") enqueueRadar(pollRadar);
  return { settings, tracking };
}

function radarDamageBonus(...states) {
  for (const state of states) {
    const percent = radarNumber(state?.totalPercent, state?.damageBonusPercent, state?.damageBonusPercentage, state?.damageBonus?.percent);
    if (percent !== undefined) return percent;
    // Only explicitly named multipliers have a known conversion to percent.
    const multiplier = radarNumber(state?.damageMultiplier);
    if (multiplier !== undefined && multiplier >= 0) return (multiplier - 1) * 100;
  }
  return null; // Unknown bonus must never satisfy a percentage rule.
}

async function notifyRadar(alerts, settings, check = () => {}) {
  check();
  if ((!settings.enabled && !settings.contractsEnabled) || !chrome.notifications) return;
  const language = await readLanguage();
  const tr = source => language === "es" ? globalThis.__weAgoSpanish?.[source] ?? source : source;
  const tracking = await readRadarTracking();
  const ledgerKey = "we-ago:radarNotified";
  const stored = (await chrome.storage.local.get(ledgerKey))[ledgerKey] || {};
  const now = Date.now();
  const ledger = Object.fromEntries(Object.entries(stored).filter(([, time]) => Number.isFinite(time) && now - time < 60 * 86400000).slice(-2000));
  for (const alert of visibleRadarAlerts(alerts, tracking, settings)) {
    check();
    if (alert.stale) continue;
    if (alert.expiresAt && (!Number.isFinite(Date.parse(alert.expiresAt)) || Date.parse(alert.expiresAt) <= now)) continue;
    const qualifies = settings.notifyBounty && alert.rate >= settings.minimumBounty && alert.budget > 0
        && Number.isFinite(alert.damageBonusPercent) && alert.damageBonusPercent >= settings.minimumDamageBonus;
    if (!qualifies) continue;
    const key = `${alert.type === "CONTRACT" ? "contract" : "bounty"}:${alert.battleId}:${alert.roundNumber}:${alert.side}${alert.type === "CONTRACT" ? ":" + alert.contractId : ""}`;
    if (Object.hasOwn(ledger, key)) continue;
    try {
      await chrome.notifications.create("we-ago-radar:" + key, {
        type: "basic", title: `${alert.regionName} · ${tr(alert.type === "CONTRACT" ? "Contract auction" : "Bounty opportunity")}`,
        message: `+${alert.rate.toFixed(2)}${tr(" / 1k damage")} · ${tr("Available ")}${alert.budget.toLocaleString(language === "es" ? "es-ES" : "en-US", { maximumFractionDigits: 3 })} · ${alert.damageBonusPercent >= 0 ? "+" : ""}${alert.damageBonusPercent.toFixed(1)}${tr("% damage")} (${tr(alert.side)})`,
        iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAY0lEQVR4nO3WsQ0AIAhEUWdwEntHdETXsNcNBFSiJr+4Eu5VhBBz6jcTAAAAYB1otYhxA2jKrQgVwFJshbwP2CnXIKaAE+USAgAAAADevoQnENLuPwArEO3Ovz4ijwAAcB0wAHPMKMZjZw98AAAAAElFTkSuQmCC",
        silent: true
      });
      ledger[key] = now;
      // Persist after each success so worker suspension cannot repeat a batch.
      await chrome.storage.local.set({ [ledgerKey]: ledger });
    } catch { /* A blocked OS notification is retried on the next poll. */ }
  }
}

chrome.notifications?.onClicked.addListener(notificationId => {
  const match = /^we-ago-radar:(?:closing|bounty|contract):([a-zA-Z0-9_-]{1,100}):\d+(?::(?:attacker|defender))?(?::[a-zA-Z0-9_-]{1,100})?$/.exec(notificationId);
  if (!match) return;
  enqueueRadar(async () => {
    const path = `/battle/${match[1]}`;
    const tabs = await chrome.tabs.query({ url: ["https://app.warera.io/*", "https://warera.io/*"] });
    const existing = tabs.find(tab => { try { return new URL(tab.url).pathname === path; } catch { return false; } });
    if (existing) await chrome.tabs.update(existing.id, { active: true });
    else await chrome.tabs.create({ url: "https://app.warera.io" + path });
    await chrome.notifications.clear(notificationId);
  });
});

function radarList(data, key) {
  const value = radarUnwrap(data);
  return Array.isArray(value) ? value : Array.isArray(value?.[key]) ? value[key] : Array.isArray(value?.items) ? value.items : [];
}

function radarNames(data, key) {
  const value = radarUnwrap(data);
  const records = value?.[key] ?? value ?? {};
  return new Map(Object.entries(records).map(([id, record]) => [radarId(record) || id, record]));
}

function evaluateRadarBattle(battle, live, orders, settings, regions, countries, now = Date.now(), bonuses = {}) {
  if (!battle || battle.isActive === false || live?.battle?.isActive === false) return [];
  const battleId = radarId(battle);
  if (typeof battleId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(battleId)) return [];
  const round = live?.round ?? (typeof battle.currentRound === "object" ? battle.currentRound : null);
  const roundNumber = radarNumber(round?.roundNumber, round?.number, live?.roundNumber, battle.roundNumber, battle.currentRoundNumber,
    Array.isArray(battle.rounds) ? battle.rounds.length : undefined);
  const knownRound = Number.isInteger(roundNumber) && roundNumber > 0;
  const regionRef = battle.defender?.region ?? battle.defenderRegion ?? battle.region ?? battle.defenderRegionId;
  const region = regions.get(radarId(regionRef));
  const regionName = region?.name ?? regionRef?.name ?? "Unknown region";
  // Bounty eligibility does not depend on round metadata being returned.
  const base = { battleId, roundNumber: knownRound ? roundNumber : 0, regionName: String(regionName).slice(0, 100) };
  const alerts = [];
  for (const side of ["attacker", "defender"]) {
    const state = round?.[side] ?? live?.[side];
    const sideState = { ...battle[side],
      moneyPool: radarNumber(live?.battle?.[side + "MoneyPool"], battle[side]?.moneyPool),
      moneyPer1kDamages: radarNumber(live?.battle?.[side + "MoneyPer1kDamages"], battle[side]?.moneyPer1kDamages),
      bountyEffectiveAt: live?.battle?.[side + "BountyEffectiveAt"] ?? battle[side]?.bountyEffectiveAt
    };
    const countryRef = sideState?.country;
    const countryName = countries.get(radarId(countryRef))?.name ?? countryRef?.name ?? side;
    // The native battle side carries the public mercenary pool/rate; active
    // order records can also carry explicit payout/budget fields. Never sum rates.
    const candidates = [sideState, ...radarList(orders[side], "orders")];
    let best;
    for (const order of candidates) {
      if (!order || order.isActive === false || (order.status && order.status !== "active")) continue;
      if (order.bountyEffectiveAt && Date.parse(order.bountyEffectiveAt) > now) continue;
      if (order.expiresAt && Date.parse(order.expiresAt) <= now) continue;
      if (order.battle && radarId(order.battle) !== battleId || order.side && order.side !== side) continue;
      const rate = radarNumber(order.moneyPer1kDamages, order.rewardPer1kDamage, order.rewardPer1000Damage,
        order.payPer1000Damage, order.perK, order.details?.payPer1000Damage, order.details?.perK);
      const budget = radarNumber(order.moneyPool, order.remainingBudget, order.budgetLeft, order.details?.remainingBudget);
      if (rate > 0 && rate >= settings.minimumBounty && budget > 0 && (!best || rate > best.rate)) best = { rate, budget };
    }
    const bonus = radarDamageBonus(bonuses?.[side], state, live?.[side], sideState);
    if (best) alerts.push({ ...base, type: "HIGH_BOUNTY", side, countryName: String(countryName).slice(0, 100), damageBonusPercent: bonus, ...best });
  }
  return alerts;
}

const pageSnapshots = new Map();
async function radarReadPages(client, procedure, input, key, firstPage) {
  client.check?.();
  const snapshotKey = firstPage === undefined ? await digest(canonicalJson([client.settings.token, client.provider, procedure, input, scanGenerations])) : null;
  const previous = pageSnapshots.get(snapshotKey);
  if (previous?.expiresAt > Date.now()) return previous.records;
  let expiresAt = Infinity;
  const records = [], cursors = new Set();
  let cursor;
  do {
    client.check?.();
    const response = firstPage === undefined ? await client.query(procedure, { ...input, ...(cursor ? { cursor } : {}) }, { ttlSeconds: 120 }) : null;
    if (response) expiresAt = Math.min(expiresAt, response.expiresAt);
    const page = radarUnwrap(response ? response.data : firstPage);
    firstPage = undefined;
    if (!Array.isArray(page) && !Array.isArray(page?.items) && !Array.isArray(page?.[key])) {
      throw Object.assign(failure("INVALID_RESPONSE", "Search results unavailable."), { responseIssue: "missing results", procedure });
    }
    const items = radarList(page, key);
    // Some ranking responses retain the last cursor on an empty final page.
    // There is nothing left to fetch; do not reject all preceding results.
    if (!items.length && (page?.nextCursor == null || typeof page.nextCursor === "string")) break;
    records.push(...items);
    cursor = page?.nextCursor;
    if (cursor !== undefined && cursor !== null && cursor !== "" && (typeof cursor !== "string" || cursors.has(cursor))) {
      throw Object.assign(failure("INVALID_RESPONSE", "Search pagination did not advance."), {
        responseIssue: typeof cursor === "string" ? "repeated cursor" : "invalid cursor", procedure,
        partialRecords: records
      });
    }
    if (cursor) cursors.add(cursor);
  } while (cursor);
  if (snapshotKey && Number.isFinite(expiresAt) && expiresAt > Date.now()) {
    pageSnapshots.set(snapshotKey, {records, expiresAt});
    while (pageSnapshots.size > 100) pageSnapshots.delete(pageSnapshots.keys().next().value);
  }
  return records;
}

function radarReadIssue(label, error) {
  if (error?.httpStatus === 429) return `${label}: rate limited · retrying.`;
  if (error?.httpStatus === 401) return `${label}: check API token.`;
  if (error?.httpStatus === 403) return `${label}: API access denied.`;
  if ([404, 405].includes(error?.httpStatus)) return `${label}: API endpoint unavailable.`;
  if (error?.code === "NETWORK_ERROR") return `${label}: connection failed · retrying.`;
  const detail = Number.isInteger(error?.httpStatus) ? `HTTP ${error.httpStatus}` : error?.code === "INVALID_RESPONSE"
    ? `invalid response${error.responseIssue ? ` (${error.responseIssue})` : ""}` : "query rejected";
  return `${label}: ${detail} · retrying.`;
}

function evaluateRadarContracts(auctions, battle, live, bonuses, settings, regions, now = Date.now(), requireBonus = true) {
  if (!battle || battle.isActive === false || live?.battle?.isActive === false || !settings.contractsEnabled) return [];
  const battleId = radarId(battle);
  const roundNumber = radarNumber(live?.round?.roundNumber, live?.round?.number, battle.currentRoundNumber, Array.isArray(battle.rounds) ? battle.rounds.length : undefined) ?? 0;
  const regionRef = battle.defender?.region ?? battle.defenderRegion ?? battle.region ?? battle.defenderRegionId;
  const regionName = String(regions.get(radarId(regionRef))?.name ?? regionRef?.name ?? "Unknown region").slice(0, 100);
  const seen = new Set();
  return auctions.flatMap(auction => {
    if (!radarValidId(radarId(auction)) || seen.has(radarId(auction)) || radarId(auction.battle) !== battleId || auction.status !== "active"
      || !Number.isFinite(Date.parse(auction.expiresAt)) || Date.parse(auction.expiresAt) <= now
      || auction.roundNumber != null && (auction.roundNumber !== roundNumber || live?.round?.isActive === false)) return [];
    let side = auction.side ?? auction.forCountrySide;
    if (!["attacker", "defender"].includes(side)) {
      if (!radarValidId(radarId(auction.forCountry))) return [];
      const sides = ["attacker", "defender"].filter(value => radarId(battle[value]?.country) === radarId(auction.forCountry));
      if (sides.length !== 1) return [];
      side = sides[0];
    }
    const current = radarNumber(auction.currentPerK);
    if (!(current > 0) || !Array.isArray(auction.bids)) return [];
    // Native auctions are reverse bids: a subsequent bid must be 0.01 lower.
    if (auction.bids.length && current <= 0.01) return [];
    const rate = auction.bids.length ? Math.max(Math.round((current - 0.01) * 100) / 100, 0.01) : current;
    const damageBonusPercent = radarDamageBonus(bonuses?.[side], live?.round?.[side], live?.[side], battle[side]);
    const funding = radarNumber(auction.currentPayout, auction.budget);
    const minimumDamage = radarNumber(auction.minimumDamage);
    if (!(funding > 0) || !(minimumDamage > 0)) return [];
    // Available payout at the next admissible bid, bounded by reserved funds.
    const budget = Math.min(funding, Math.round(rate * minimumDamage) / 1000);
    if (!(rate >= settings.minimumBounty) || !(budget > 0)
      || requireBonus && (!Number.isFinite(damageBonusPercent) || !(damageBonusPercent >= settings.minimumDamageBonus))) return [];
    seen.add(radarId(auction));
    return [{ type: "CONTRACT", battleId, roundNumber, regionName, side, contractId: radarId(auction), rate, budget,
      damageBonusPercent, minimumDamage,
      professionalsOnly: auction.professionalsOnly === true, expiresAt: auction.expiresAt }];
  });
}

async function pollRadar(check = makeScanCheck("radar")) {
  const settings = await readSettings();
  const radar = await readRadarSettings();
  const authInvalid = (await chrome.storage.local.get("we-ago:radarAuthInvalid"))["we-ago:radarAuthInvalid"];
  try {
    check();
    if ((!radar.enabled && !radar.contractsEnabled) || !settings.token || authInvalid) { await publishRadar([], 0, "", check); return; }
    const client = new WarEraClient(settings, check);
    const previous = (await chrome.storage.local.get("activeAlerts")).activeAlerts || [];
    const battles = await radarReadPages(client, "battle.getBattles", { isActive: true, limit: 100, filter: "all" }, "battles");
    const issues = new Set();
    let contractsFailed = false;
    let auctions = [];
    if (radar.contractsEnabled) {
      try { auctions = await radarReadPages(client, "mercenaryContractAuction.getPaginatedAuctions", { status: "active", limit: 50 }, "auctions"); }
      catch (error) { check(); contractsFailed = true; issues.add(radarReadIssue("Contracts", error)); }
    }
    const staticResults = await client.batch([
      { procedure: "region.getRegionsObject", input: {}, ttlSeconds: 600 },
      { procedure: "country.getAllCountries", input: {}, ttlSeconds: 600 }
    ]);
    const regions = radarNames(staticResults[0].data, "regions");
    const countries = radarNames(staticResults[1].data, "countries");
    const unique = [...new Map(battles.filter(battle => battle?.isActive !== false && radarId(battle)).map(battle => [radarId(battle), battle])).values()];
    const alerts = [];
    // Four reads per battle; the shared scheduler bounds GET batch count and URL size.
    for (let offset = 0; offset < unique.length; offset += 4) {
      check();
      const slice = unique.slice(offset, offset + 4);
      const callsFor = battle => [
        { procedure: "battle.getLiveBattleData", input: { battleId: radarId(battle) }, ttlSeconds: 120 },
        { procedure: "battle.getById", input: { battleId: radarId(battle) }, ttlSeconds: 120 },
        ...(radar.enabled ? ["attacker", "defender"].map(side => ({ procedure: "battleOrder.getByBattle", input: { battleId: radarId(battle), side }, ttlSeconds: 120 })) : [])
      ];
      // Independent caller promises still compose into shared GET batches, but
      // one failed battle/bonus no longer discards the other battles in a chunk.
      const outcomes = await Promise.allSettled(slice.map(battle => client.batch(callsFor(battle))));
      check();
      // This game-client read is absent from OpenAPI. An unavailable bonus
      // must not hide bounties returned by otherwise successful public reads.
      const bonuses = await Promise.allSettled(slice.map((battle, index) => {
        if (outcomes[index].status !== "fulfilled") return Promise.resolve(null);
        const data = outcomes[index].value.map(result => radarUnwrap(result.data));
        const detail = { ...battle, ...data[1] }, now = Date.now();
        const bountyCandidate = radar.enabled && evaluateRadarBattle(detail, data[0], { attacker: data[2], defender: data[3] }, radar, regions, countries, now).length > 0;
        const contractCandidate = radar.contractsEnabled && evaluateRadarContracts(auctions, detail, data[0], {}, radar, regions, now, false).length > 0;
        return bountyCandidate || contractCandidate
          ? client.query("battle.getDamageBonuses", { battleId: radarId(battle) }, { ttlSeconds: 120 }) : Promise.resolve(null);
      }));
      check();
      slice.forEach((battle, index) => {
        if (outcomes[index].status === "rejected") {
          alerts.push(...previous.filter(alert => alert.battleId === radarId(battle)).map(alert => ({ ...alert, stale: true })));
          issues.add(radarReadIssue("Battle data", outcomes[index].reason));
          return;
        }
        const data = outcomes[index].value.map(result => radarUnwrap(result.data));
        const detail = { ...battle, ...data[1] };
        const outcome = bonuses[index];
        if (outcome.status === "rejected") issues.add(radarReadIssue("Damage bonus", outcome.reason));
        const bonus = outcome.status === "fulfilled" ? radarUnwrap(outcome.value?.data) : undefined;
        if (radar.enabled) alerts.push(...evaluateRadarBattle(detail, data[0], { attacker: data[2], defender: data[3] }, radar, regions, countries, Date.now(), bonus));
        if (radar.contractsEnabled) alerts.push(...evaluateRadarContracts(auctions, detail, data[0], bonus, radar, regions));
        if (outcome.status === "rejected" && detail.isActive !== false && data[0]?.battle?.isActive !== false) {
          for (const alert of previous.filter(alert => alert.battleId === radarId(battle))) {
            const current = alerts.find(value => value.type === alert.type && value.battleId === alert.battleId
              && value.side === alert.side && value.roundNumber === alert.roundNumber && value.contractId === alert.contractId);
            if (current && !Number.isFinite(current.damageBonusPercent)) {
              current.damageBonusPercent = alert.damageBonusPercent; current.stale = true;
            } else if (!current && alert.type === "CONTRACT" && auctions.some(auction => radarId(auction) === alert.contractId)) {
              alerts.push({ ...alert, stale: true });
            }
          }
        }
      });
    }
    if (contractsFailed) alerts.push(...previous.filter(alert => alert.type === "CONTRACT" && unique.some(battle => radarId(battle) === alert.battleId)
      && !alerts.some(value => value.contractId === alert.contractId && value.type === alert.type)).map(alert => ({ ...alert, stale: true })));
    alerts.sort((a, b) => b.rate - a.rate
      || a.battleId.localeCompare(b.battleId) || a.side.localeCompare(b.side));
    await publishRadar(alerts, Date.now(), [...issues].join(" "), check);
    await notifyRadar(alerts, radar, check);
  } catch (error) {
    if (error.code === "SCAN_CANCELLED") return;
    check();
    const previous = await chrome.storage.local.get(["activeAlerts", "lastRadarSync"]);
    check();
    await publishRadar((previous.activeAlerts || []).map(alert => ({ ...alert, stale: true })), previous.lastRadarSync || 0, "Last known · " + radarReadIssue("Radar", error), check);
    if (error?.httpStatus === 401) {
      await chrome.storage.local.set({ "we-ago:radarAuthInvalid": true });
      await chrome.alarms.clear(RADAR_ALARM);
    }
  }
}

async function configureRadar(poll = false) {
  const check = makeScanCheck("radar");
  const [settings, radar] = await Promise.all([readSettings(), readRadarSettings()]);
  const authInvalid = (await chrome.storage.local.get("we-ago:radarAuthInvalid"))["we-ago:radarAuthInvalid"];
  if (!settings.token || (!radar.enabled && !radar.contractsEnabled) || authInvalid) {
    await chrome.alarms.clear(RADAR_ALARM);
    await publishRadar([], 0);
    return;
  }
  if (!await chrome.alarms.get(RADAR_ALARM)) await chrome.alarms.create(RADAR_ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
  if (poll) { check(); await pollRadar(check); }
}

let radarQueue = Promise.resolve();
const pendingRadar = new Set();
function enqueueRadar(task) {
  // One pending rerun per task, even when scans exceed the alarm period.
  // Admit only the active scan as a read: queued scans must not extend the
  // settings/cache write barrier before they have even started.
  if (pendingRadar.has(task)) return;
  pendingRadar.add(task);
  const operation = radarQueue.then(() => enqueueOperation(() => {
    pendingRadar.delete(task);
    return task();
  }, true));
  radarQueue = operation.catch(() => {});
}
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === CACHE_SWEEP_ALARM) void enqueueOperation(runCacheSweep).catch(() => {});
  if (alarm.name === RADAR_ALARM) enqueueRadar(pollRadar);
  if (alarm.name === LOOT_RADAR_ALARM) enqueueRadar(pollLootRadar);
});
chrome.runtime.onInstalled.addListener(() => enqueueRadar(async () => { await configureRadar(true); await configureLootRadar(true); }));
chrome.runtime.onStartup.addListener(() => enqueueRadar(async () => { await configureRadar(true); await configureLootRadar(true); }));
// MV3 may terminate the worker; restore a missing alarm whenever it wakes.
enqueueRadar(() => configureRadar());
enqueueRadar(() => configureLootRadar());

const LOOT_RADAR_SETTINGS_KEY = "we-ago:lootRadar";
const LOOT_RADAR_STATE_KEY = "we-ago:lootRadarResults";
const LOOT_RADAR_ALARM = "we-ago-loot-radar-poll";

async function readLootRadarSettings() {
  const stored = (await chrome.storage.local.get(LOOT_RADAR_SETTINGS_KEY))[LOOT_RADAR_SETTINGS_KEY];
  const limit = value => Number.isFinite(value) && value >= 0 ? value : null;
  return { legendaryDamage: limit(stored?.legendaryDamage), mythicDamage: limit(stored?.mythicDamage) };
}

async function lootRadarSnapshot() {
  const settings = await readLootRadarSettings();
  const enabled = (await readFeatures()).lootRadar;
  const saved = (await chrome.storage.local.get(LOOT_RADAR_STATE_KEY))[LOOT_RADAR_STATE_KEY];
  const fresh = saved?.version === 2;
  const items = (saved?.items || []).filter(item => item.side === "merged" && item.damage < settings[item.rarity === "legendary" ? "legendaryDamage" : "mythicDamage"]);
  return { settings, enabled, items: enabled && fresh ? items : [], syncedAt: saved?.syncedAt || 0, issue: enabled ? saved?.issue || "" : "" };
}

async function publishLootRadar(items, syncedAt = Date.now(), issue = "", check = () => {}) {
  check();
  await chrome.storage.local.set({ [LOOT_RADAR_STATE_KEY]: { version: 2, items, syncedAt, issue } });
  await broadcastRadar({ type: "WE_AGO_LOOT_RADAR_UPDATE", payload: await lootRadarSnapshot() }, check);
}

// Conditional forecast: the current cumulative-damage leader wins future ticks.
function lootRoundEstimate(round, observedAt) {
  if (round?.isActive !== true || !Number.isFinite(observedAt)) return null;
  const values = [round.attackerPoints, round.defenderPoints, round.attackerDamages, round.defenderDamages];
  if (!values.every(value => Number.isFinite(value) && value >= 0)
    || !Number.isInteger(round.attackerPoints) || !Number.isInteger(round.defenderPoints)
    || round.attackerPoints >= 300 || round.defenderPoints >= 300
    || round.attackerDamages === round.defenderDamages) return null;
  const nextTickAt = Date.parse(round.nextTickAt);
  if (!Number.isFinite(nextTickAt) || nextTickAt < observedAt || nextTickAt > observedAt + 120000) return null;
  let total = round.attackerPoints + round.defenderPoints;
  if (round.actualTickPoints !== Math.floor(total / 100) + 1) return null;
  let points = round.attackerDamages > round.defenderDamages ? round.attackerPoints : round.defenderPoints;
  let ticks = 0;
  while (points < 300) {
    const gain = Math.floor(total / 100) + 1;
    points += gain; total += gain; ticks++;
  }
  return { endsAt: nextTickAt + (ticks - 1) * 120000, observedAt };
}

function evaluateLootRanking(rankings, context, settings, itemDefinitions = {}) {
  // A side-only damage value is unsafe: the recipient may also have fought
  // for the other side. Only the authoritative combined ranking can qualify.
  if (context.side !== "merged") return [];
  const seen = new Set();
  return rankings.flatMap(entry => {
    const loot = entry?.lootItem;
    const code = loot?.code;
    const rarity = loot?.rarity ?? itemDefinitions[code]?.rarity;
    if (!["legendary", "mythic"].includes(rarity) || typeof code !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(code)
      || !Number.isFinite(entry.value) || entry.value < 0 || !Number.isInteger(entry.rank) || entry.rank < 1) return [];
    const maximum = settings[rarity === "legendary" ? "legendaryDamage" : "mythicDamage"];
    // Current ranking assignment is a moving cutoff, not a guaranteed reward.
    // Display total damage needed to pass its current recipient, not weapon
    // attack, item price, nor extra damage for an unidentified player.
    const damage = Math.floor(entry.value) + 1;
    const targetId = `${context.battleId}:${context.scope}:${context.side}:${entry.rank}`;
    if (!Number.isFinite(maximum) || damage >= maximum || seen.has(targetId)) return [];
    seen.add(targetId);
    return [{ ...context, targetId, itemCode: code, rarity, damage, rank: entry.rank }];
  });
}

async function pollLootRadar(check = makeScanCheck("loot")) {
  const [connection, settings, features] = await Promise.all([readSettings(), readLootRadarSettings(), readFeatures()]);
  try {
    check();
    if (!features.lootRadar || !connection.token || settings.legendaryDamage === null && settings.mythicDamage === null) {
      await publishLootRadar([], 0, "", check); return;
    }
    const client = new WarEraClient(connection, check), matches = [], issues = new Set();
    const previous = (await chrome.storage.local.get(LOOT_RADAR_STATE_KEY))[LOOT_RADAR_STATE_KEY];
    const retain = (battleId, scope, roundNumber) => {
      if (previous?.version !== 2) return;
      matches.push(...previous.items.filter(item => item.battleId === battleId && (!scope || item.scope === scope)
        && (scope !== "round" || item.roundNumber === roundNumber)).map(item => ({ ...item, stale: true })));
    };
    const battles = await radarReadPages(client, "battle.getBattles", { isActive: true, limit: 100, filter: "all" }, "battles");
    const [regionData, configData] = await client.batch([
      { procedure: "region.getRegionsObject", input: {}, ttlSeconds: 600 },
      { procedure: "gameConfig.getGameConfig", input: {}, ttlSeconds: 600 }
    ]);
    const regions = radarNames(regionData.data, "regions"), definitions = radarUnwrap(configData.data)?.items || {};
    const unique = [...new Map(battles.filter(battle => battle?.isActive !== false && radarValidId(radarId(battle))).map(battle => [radarId(battle), battle])).values()];
    await globalThis.__weAgoScans.map(unique, 2, async battle => {
      check();
      const battleId = radarId(battle);
      try {
        const details = await client.batch([
          { procedure: "battle.getLiveBattleData", input: { battleId }, ttlSeconds: 120 },
          { procedure: "battle.getById", input: { battleId }, ttlSeconds: 120 }
        ]);
        const live = radarUnwrap(details[0].data), detail = radarUnwrap(details[1].data);
        if (live?.battle?.isActive === false || detail?.isActive === false) return;
        const regionRef = detail?.defender?.region ?? battle.defender?.region ?? battle.defenderRegionId;
        const regionName = String(regions.get(radarId(regionRef))?.name ?? regionRef?.name ?? "Unknown region").slice(0, 100);
        const roundId = live?.round?.roundId ?? live?.round?._id ?? radarId(detail?.currentRound);
        const roundNumber = radarNumber(live?.round?.roundNumber, live?.round?.number, Array.isArray(detail?.rounds) ? detail.rounds.length : undefined) ?? 0;
        const roundEstimate = lootRoundEstimate(live?.round, details[0].createdAt);
        const scopes = [{ scope: "battle", input: { battleId } }];
        if (radarValidId(roundId) && live?.round?.isActive === true) scopes.push({ scope: "round", input: { roundId } });
        const searches = scopes.map(scope => ({ scope, side: "merged",
          input: { ...scope.input, side: "merged", type: "user", dataType: "damage", limit: 100 } }));
        const firstPages = await Promise.allSettled(searches.map(search => client.query("battleRanking.getRanking", search.input, { ttlSeconds: 120 })));
        check();
        for (const [index, { scope, side, input }] of searches.entries()) {
          try {
            if (firstPages[index].status === "rejected") throw firstPages[index].reason;
            const ranking = await radarReadPages(client, "battleRanking.getRanking", input, "rankings", firstPages[index].value.data);
            matches.push(...evaluateLootRanking(ranking, { battleId, regionName, scope: scope.scope, side, roundNumber, roundEstimate }, settings, definitions));
          } catch (error) {
            check();
            if (error.responseIssue === "repeated cursor" && error.partialRecords?.length) {
              matches.push(...evaluateLootRanking(error.partialRecords, { battleId, regionName, scope: scope.scope, side, roundNumber, roundEstimate }, settings, definitions));
              issues.add(`Loot ${scope.scope} rankings: partial results · pagination stalled.`);
            } else { retain(battleId, scope.scope, roundNumber); issues.add(radarReadIssue(`Loot ${scope.scope} rankings`, error)); }
          }
        }
      } catch (error) { check(); retain(battleId); issues.add(radarReadIssue("Loot battle data", error)); }
    });
    matches.sort((a, b) => a.damage - b.damage || a.targetId.localeCompare(b.targetId));
    await publishLootRadar(matches, Date.now(), [...issues].join(" "), check);
  } catch (error) {
    if (error.code === "SCAN_CANCELLED") return;
    check();
    const previous = (await chrome.storage.local.get(LOOT_RADAR_STATE_KEY))[LOOT_RADAR_STATE_KEY];
    check(); await publishLootRadar(previous?.version === 2 ? previous.items.map(item => ({ ...item, stale: true })) : [], previous?.syncedAt || 0, "Last known · " + radarReadIssue("Loot rankings", error), check);
  }
}

async function configureLootRadar(poll = false) {
  const check = makeScanCheck("loot");
  const [connection, settings, features] = await Promise.all([readSettings(), readLootRadarSettings(), readFeatures()]);
  if (!features.lootRadar || !connection.token || settings.legendaryDamage === null && settings.mythicDamage === null) {
    await chrome.alarms.clear(LOOT_RADAR_ALARM);
    await publishLootRadar([], 0);
    return;
  }
  if (!await chrome.alarms.get(LOOT_RADAR_ALARM)) await chrome.alarms.create(LOOT_RADAR_ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
  if (poll) { check(); await pollLootRadar(check); }
}

