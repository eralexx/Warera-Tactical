"use strict";
const assert = require("node:assert/strict");
const fs = require("./runtime.cjs");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const plain = value => JSON.parse(JSON.stringify(value));
const source = fs.readFileSync(require("node:path").join(__dirname, "../background.js"), "utf8");

function worker(saved = {}) {
  const storage = { "we-ago:features": { bountyRadar: false, contractRadar: false, lootRadar: false }, ...saved };
  const requests = [], alarms = new Map(), broadcasts = [];
  let listener, onAlarm;
  const event = { addListener() {} };
  const context = vm.createContext({
    Date, URL, TextEncoder, AbortSignal, crypto: webcrypto, setTimeout,
    fetch: async (url, options) => {
      const parsed = new URL(url);
      assert.equal(options.method, "GET"); assert.equal(options.credentials, "omit");
      assert.equal(options.headers.Authorization, "Bearer test-token");
      assert(parsed.searchParams.has("input"));
      const input = JSON.parse(parsed.searchParams.get("input"));
      const procedures = parsed.pathname.split("/").pop().split(",");
      requests.push({ procedures, input });
      const data = procedures.map((procedure, index) => {
        const args = procedures.length > 1 ? input[index] : input;
        return context.respondEnvelope?.(procedure, args) ?? { result: { data: context.respond(procedure, args) } };
      });
      return { ok: true, status: 200, json: async () => procedures.length > 1 ? data : data[0] };
    },
    chrome: {
      storage: { local: {
        get: async keys => keys === null ? { ...storage } : Object.fromEntries([].concat(keys).map(key => [key, storage[key]])),
        set: async values => Object.assign(storage, values), remove: async keys => { for (const key of [].concat(keys)) delete storage[key]; },
        setAccessLevel: async () => {}
      } },
      runtime: { id: "test", getURL: file => "chrome-extension://test/" + file,
        onMessage: { addListener(fn) { listener = fn; } }, onInstalled: event, onStartup: event },
      tabs: { query: async () => [{ id: 1 }], sendMessage: async (id, message) => broadcasts.push(message) },
      alarms: { get: async key => alarms.get(key), create: async (key, value) => alarms.set(key, value), clear: async key => alarms.delete(key),
        onAlarm: { addListener(fn) { onAlarm = fn; } } }
    }
  });
  context.respond = () => { throw Error("Unexpected read"); };
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code.includes("await ") ? "(async()=>(" + code + "))()" : code, context);
  return { storage, context, requests, alarms, broadcasts, run,
    async flush() { for (let i = 0; i < 3; i++) {
      await run("queue"); await run("radarQueue");
      await new Promise(resolve => setImmediate(resolve));
    } },
    alarm(name) { onAlarm({ name }); },
    message(message, url = "https://app.warera.io/market") {
      return new Promise(resolve => listener(message, { id: "test", url }, resolve));
    }
  };
}

(async () => {
  const h = worker(); await h.flush();
  h.context.battle = { _id: "battle1", isActive: true, rounds: ["r1", "r2"], attacker: { country: "c1" }, defender: { region: "reg1", country: "c2" } };
  h.context.live = { round: { number: 2, isActive: true } };
  h.context.bonuses = { attacker: { totalPercent: 40 }, defender: { totalPercent: 5 } };
  h.context.settings = { contractsEnabled: true, minimumBounty: 2, minimumDamageBonus: 20 };
  h.context.auction = { _id: "auction1", battle: "battle1", side: "attacker", status: "active", expiresAt: new Date(Date.now() + 60000).toISOString(),
    currentPerK: 3, currentPayout: 1500, minimumDamage: 500000, bids: [] };
  const contracts = () => h.run("evaluateRadarContracts(auctions,battle,live,bonuses,settings,new Map())");
  h.context.auctions = [h.context.auction, h.context.auction];
  assert.equal(contracts().length, 1, "duplicate page records collapse");
  assert.equal(contracts()[0].rate, 3);
  assert.equal(contracts()[0].budget, 1500, "available contract payout");
  h.context.auctions = [{ ...h.context.auction, bids: [{}] }];
  assert.equal(contracts()[0].rate, 2.99, "available reverse-bid rate, not stale current winning rate");
  assert.equal(contracts()[0].budget, 1495, "available payout follows the next bid rather than the old winning rate");
  for (const override of [{ currentPerK: 1.99 }, { side: "defender" }, { status: "won" }, { roundNumber: 1 }, { currentPayout: 0 },
    { expiresAt: new Date(Date.now() - 1).toISOString() }, { battle: "other" }]) {
    h.context.auctions = [{ ...h.context.auction, ...override }];
    assert.equal(contracts().length, 0, "exclude unqualified/unavailable contract: " + JSON.stringify(override));
  }
  h.context.auctions = [{ ...h.context.auction, side: undefined, forCountry: "c1" }];
  assert.equal(contracts().length, 1, "resolve unambiguous target country");
  h.context.bonuses = {};
  assert.equal(contracts().length, 0, "missing percentage cannot match");
  h.context.bonuses = { attacker: { totalPercent: 20 } };
  assert.equal(contracts().length, 1, "minimum bonus is inclusive");
  h.context.auctions = [{ ...h.context.auction, currentPerK: 2 }];
  assert.equal(contracts().length, 1, "minimum contract rate is inclusive");
  h.context.bountyBattle = { ...plain(h.context.battle), attacker: { moneyPool: 2000, moneyPer1kDamages: 5 } };
  const bounty = plain(h.run("evaluateRadarBattle(bountyBattle,{round:{number:2,isActive:true,attackerPoints:299}},{},{minimumBounty:2},new Map(),new Map())"));
  assert.deepEqual(bounty.map(alert => alert.type), ["HIGH_BOUNTY"], "near-ending battles no longer create individual closing alerts");
  assert.equal(bounty[0].budget, 2000, "remaining bounty value is retained");
  h.context.boundaryBattle = { ...plain(h.context.battle), _id: "6ad96b32d709c93dc731a684", attacker: { moneyPool: 100, moneyPer1kDamages: 0.05 } };
  const boundary = plain(h.run('evaluateRadarBattle(boundaryBattle,{round:{number:2}},{},{minimumBounty:0.05},new Map(),new Map(),Date.now(),{attacker:{totalPercent:0}})'));
  assert.equal(boundary.length, 1, "0.05 bounty matches a 0.05 minimum");
  assert.equal(boundary[0].damageBonusPercent, 0);
  assert.equal(h.run('evaluateRadarBattle(boundaryBattle,{}, {},{minimumBounty:0.051},new Map(),new Map()).length'), 0, "below-minimum bounty is excluded");
  h.context.boundaryAlerts = boundary;
  const boundaryNotifications = [];
  h.context.chrome.notifications = { create: async id => boundaryNotifications.push(id) };
  await h.run('notifyRadar(boundaryAlerts,{enabled:true,notifyBounty:true,minimumBounty:0.05,minimumDamageBonus:0})');
  assert.equal(boundaryNotifications.length, 1, "0.05 rate and 0% bonus meet notification minimums");
  await h.run('notifyRadar(boundaryAlerts,{enabled:true,notifyBounty:true,minimumBounty:0.05,minimumDamageBonus:0})');
  assert.equal(boundaryNotifications.length, 1, "boundary notification is deduplicated");
  await h.run('notifyRadar([{...boundaryAlerts[0],side:"defender",damageBonusPercent:null}],{enabled:true,notifyBounty:true,minimumBounty:0.05,minimumDamageBonus:0})');
  assert.equal(boundaryNotifications.length, 1, "unknown bonus is not assumed to be zero");
  const negativeSave = await h.message({ type: "WE_AGO_RADAR_TRACKING_SAVE", action: "rules", notifyBounty: true, minimumBounty: 0.05, minimumDamageBonus: -20 });
  assert.equal(negativeSave.ok, true, "negative damage bonus can be saved");
  await h.flush();
  assert.equal((await h.message({ type: "WE_AGO_RADAR_GET" })).data.settings.minimumDamageBonus, -20);
  const negativeRestart = worker(h.storage); await negativeRestart.flush();
  assert.equal((await negativeRestart.message({ type: "WE_AGO_RADAR_GET" })).data.settings.minimumDamageBonus, -20, "negative minimum survives worker restart");
  const negativeNotifications = [];
  h.context.chrome.notifications.create = async (id, value) => negativeNotifications.push(value);
  await h.run('notifyRadar([{...boundaryAlerts[0],side:"defender",damageBonusPercent:-20}],{enabled:true,notifyBounty:true,minimumBounty:0.05,minimumDamageBonus:-20})');
  assert.equal(negativeNotifications.length, 1, "negative bonus equal to minimum qualifies");
  assert.match(negativeNotifications[0].message, / · -20.0% damage/);
  await h.run('notifyRadar([{...boundaryAlerts[0],roundNumber:3,damageBonusPercent:-21}],{enabled:true,notifyBounty:true,minimumBounty:0.05,minimumDamageBonus:-20})');
  assert.equal(negativeNotifications.length, 1, "bonus below negative minimum is excluded");
  h.context.legacyClosing = [{ type: "CLOSING_SOON", battleId: "battle1", roundNumber: 2, terrain: 299 }];
  assert.equal(h.run("visibleRadarAlerts(legacyClosing,{removedBattleIds:[]},{enabled:true,contractsEnabled:true}).length"), 0, "legacy cached closing alerts are ignored");

  const contractsOnly = worker({
    "we-ago:features": { bountyRadar: false, contractRadar: true, lootRadar: false },
    "we-ago:settings": { token: "test-token", apiProvider: "official", ttls: { live: 60, static: 300, default: 60 } },
    "we-ago:radar": { minimumBounty: 2, minimumDamageBonus: 20, notifyBounty: true }
  });
  await contractsOnly.flush();
  const readBattle = plain(h.context.battle), readAuction = plain(h.context.auction);
  contractsOnly.context.respond = procedure => {
    if (procedure === "battleOrder.getByBattle") throw Error("Bounty-only orders must not be read when disabled");
    if (procedure === "battle.getBattles") return { items: [readBattle] };
    if (procedure === "mercenaryContractAuction.getPaginatedAuctions") return { items: [readAuction] };
    if (procedure === "battle.getById") return readBattle;
    if (procedure === "battle.getLiveBattleData") return { round: { number: 2, isActive: true, attackerPoints: 275 } };
    if (procedure === "battle.getDamageBonuses") return { attacker: { totalPercent: 40 } };
    if (procedure === "region.getRegionsObject") return { reg1: { name: "Paris" } };
    if (procedure === "country.getAllCountries") return [];
    throw Error(procedure);
  };
  const notifications = [];
  contractsOnly.context.chrome.notifications = { create: async (id, value) => notifications.push({ id, value }) };
  await contractsOnly.run("pollRadar()");
  assert.deepEqual(plain(contractsOnly.storage.activeAlerts).map(alert => alert.type), ["CONTRACT"], "contract-only scan excludes closing/bounty rows");
  assert.equal(notifications.length, 1, "matching contracts use the opt-in opportunity notification rule");
  assert(notifications[0].value.message.includes("Available " + (1500).toLocaleString("en-US", { maximumFractionDigits: 3 })));
  const contractReads = contractsOnly.requests.length;
  await contractsOnly.run("pollRadar()");
  assert.equal(contractsOnly.requests.length, contractReads); assert.equal(notifications.length, 1, "contract cache and notification dedup");
  const degraded = worker({
    "we-ago:features": { bountyRadar: true, contractRadar: true, lootRadar: false },
    "we-ago:settings": { token: "test-token", apiProvider: "official", ttls: { live: 60, static: 300, default: 60 } }
  });
  await degraded.flush();
  degraded.context.respond = (procedure, input) => {
    if (procedure === "battle.getBattles") return { items: [{ ...readBattle }, { ...readBattle, _id: "badBattle" }] };
    if (procedure === "battle.getById") return { ...readBattle, attacker: { ...readBattle.attacker, moneyPool: 100, moneyPer1kDamages: 3 } };
    if (procedure === "battle.getLiveBattleData") return { round: { number: 2, isActive: true } };
    if (procedure === "battleOrder.getByBattle" || procedure === "country.getAllCountries") return [];
    if (procedure === "region.getRegionsObject") return {};
    throw Error(procedure);
  };
  degraded.context.respondEnvelope = (procedure, input) => {
    const status = procedure === "mercenaryContractAuction.getPaginatedAuctions" ? 403
      : procedure === "battle.getDamageBonuses" || procedure === "battle.getById" && input.battleId === "badBattle" ? 404 : null;
    return status ? { error: { data: { httpStatus: status } } } : null;
  };
  await degraded.run("pollRadar()");
  assert.equal(degraded.storage.activeAlerts.length, 1, "healthy bounty survives failed contract, bonus and another battle");
  assert.equal(degraded.storage.activeAlerts[0].type, "HIGH_BOUNTY");
  assert.match(degraded.storage.radarIssue, /Contracts: API access denied/);
  assert.match(degraded.storage.radarIssue, /Damage bonus: API endpoint unavailable/);
  assert.match(degraded.storage.radarIssue, /Battle data: API endpoint unavailable/);
  assert.notEqual(degraded.storage["we-ago:radarAuthInvalid"], true, "endpoint-level denial cannot invalidate the account token");
  const gated = worker({ "we-ago:features": { bountyRadar: true, contractRadar: true, lootRadar: false },
    "we-ago:settings": { token: "test-token", apiProvider: "official", ttls: { live: 60, static: 300, default: 60 } } });
  await gated.flush();
  gated.context.respond = (procedure, input) => {
    if (procedure === "battle.getBattles") return { items: [{ ...readBattle, _id: "candidate" }, { ...readBattle, _id: "empty" }] };
    if (procedure === "mercenaryContractAuction.getPaginatedAuctions") return { items: [{ ...readAuction, battle: "empty", minimumDamage: 0 }] };
    if (procedure === "battle.getById") return { ...readBattle, _id: input.battleId, attacker: { moneyPool: input.battleId === "candidate" ? 100 : 0, moneyPer1kDamages: 3 } };
    if (procedure === "battle.getLiveBattleData") return { round: { number: 2, isActive: true } };
    if (procedure === "battle.getDamageBonuses") { assert.equal(input.battleId, "candidate", "noncandidate battle skips optional bonus read"); return { attacker: { totalPercent: 40 } }; }
    return [];
  };
  await gated.run("pollRadar()");
  assert.equal(gated.storage.activeAlerts.length, 1);
  assert.equal(gated.storage.activeAlerts[0].damageBonusPercent, 40, "visible bounty retains its bonus");
  await contractsOnly.message({ type: "WE_AGO_FEATURES_SAVE", features: { contractRadar: false } }, "chrome-extension://test/popup.html");
  await contractsOnly.flush(); assert.equal(contractsOnly.alarms.has("we-ago-radar-poll"), false);
  contractsOnly.alarm("we-ago-radar-poll"); await contractsOnly.flush(); assert.equal(contractsOnly.requests.length, contractReads, "disabled contracts stop future reads");
  assert.equal(notifications.length, 1, "disabled contracts stop notifications");

  const rankings = [
    { rank: 2, value: 499999, lootItem: { code: "tank", skills: { attack: 9999 } }, price: 100000 },
    { rank: 3, value: 500000, lootItem: { code: "tank", skills: { attack: 1 } }, price: 1 },
    { rank: 1, value: 900000, lootItem: { code: "jet" } },
    { rank: 4, value: 10, lootItem: { code: "unknown" } },
    { rank: 5, value: 20 }
  ];
  h.context.rankings = rankings.concat(rankings[0]);
  h.context.rankContext = { battleId: "battle1", scope: "round", side: "merged", roundNumber: 2 };
  h.context.limits = { legendaryDamage: 500001, mythicDamage: 1000000 };
  h.context.definitions = { tank: { rarity: "legendary" }, jet: { rarity: "mythic" } };
  const targets = plain(h.run("evaluateLootRanking(rankings,rankContext,limits,definitions)"));
  assert.deepEqual(targets.map(x => x.damage), [500000, 900001], "total damage to overtake current recipient; ignores price and weapon stats");
  h.context.limits.legendaryDamage = null;
  assert.equal(h.run("evaluateLootRanking(rankings,rankContext,limits,definitions).length"), 1, "blank disables one rarity");

  h.context.splitRecipient = [{ user: "switcher", rank: 714, value: 2588, lootItem: { code: "boots5", rarity: "legendary" } }];
  h.context.sideContext = { ...plain(h.context.rankContext), side: "attacker" };
  h.context.splitLimits = { legendaryDamage: 100000, mythicDamage: 30000 };
  assert.equal(h.run("evaluateLootRanking(splitRecipient,sideContext,splitLimits).length"), 0, "a 2,588-damage side entry cannot qualify a loot target");
  h.context.splitRecipient[0].value = 20002588;
  assert.equal(h.run("evaluateLootRanking(splitRecipient,rankContext,splitLimits).length"), 0, "combined high damage on the other side excludes the screenshot edge case");
  h.context.splitLimits.legendaryDamage = 25000000;
  assert.equal(h.run("evaluateLootRanking(splitRecipient,rankContext,splitLimits)[0].damage"), 20002589, "combined recipient damage remains discoverable under a sufficient maximum");

  h.storage["we-ago:settings"] = { token: "test-token", apiProvider: "official", ttls: { live: 60, static: 300, default: 60 } };
  h.storage["we-ago:features"].lootRadar = true;
  h.storage["we-ago:lootRadar"] = { legendaryDamage: 100000, mythicDamage: 30000 };
  h.storage["we-ago:lootRadarResults"] = { syncedAt: Date.now(), items: [{ side: "attacker", damage: 2589, rarity: "legendary" }] };
  assert.equal((await h.message({ type: "WE_AGO_LOOT_RADAR_GET" })).data.items.length, 0, "old side-only snapshots are invalidated immediately");
  h.context.respond = (procedure, input) => {
    assert(!procedure.startsWith("itemOffer."), "loot search must not query the market");
    if (procedure === "battle.getBattles") return { items: [plain(h.context.battle)] };
    if (procedure === "battle.getById") return { ...plain(h.context.battle), currentRound: "round2" };
    if (procedure === "battle.getLiveBattleData") return { round: { roundId: "round2", number: 2, isActive: true,
      attackerPoints: 299, defenderPoints: 0, attackerDamages: 100, defenderDamages: 10, actualTickPoints: 3,
      nextTickAt: new Date(Date.now() + 60000).toISOString() }, battle: { isActive: true } };
    if (procedure === "region.getRegionsObject") return { reg1: { name: "Paris" } };
    if (procedure === "gameConfig.getGameConfig") return { items: plain(h.context.definitions) };
    if (procedure === "battleRanking.getRanking") {
      assert.equal(input.type, "user"); assert.equal(input.dataType, "damage");
      assert(!(input.battleId && input.roundId), "rankings scope round and battle separately");
      assert.equal(input.side, "merged", "loot cutoffs must include damage dealt on both sides");
      if (input.cursor) {
        assert.equal(input.cursor, "page2", "opaque string cursors pass through unchanged");
        return { items: [rankings[2]] };
      }
      return { items: rankings.slice(0, 2), nextCursor: "page2" };
    }
    throw Error(procedure);
  };
  const saved = await h.message({ type: "WE_AGO_LOOT_RADAR_SAVE", settings: { legendaryDamage: 500001, mythicDamage: 1000000 } });
  assert.equal(saved.ok, true); await h.flush();
  assert.equal(h.alarms.get("we-ago-loot-radar-poll").periodInMinutes, 1);
  const requestCount = h.requests.length;
  const snapshot = (await h.message({ type: "WE_AGO_LOOT_RADAR_GET" })).data;
  h.context.etaNow = Date.now();
  h.context.etaRound = { isActive: true, attackerPoints: 299, defenderPoints: 0, attackerDamages: 100, defenderDamages: 10,
    actualTickPoints: 3, nextTickAt: new Date(h.context.etaNow + 45000).toISOString() };
  assert.equal(h.run("lootRoundEstimate(etaRound, etaNow).endsAt"), h.context.etaNow + 45000, "final tick is anchored to server time");
  h.context.etaRound.attackerPoints = 99; h.context.etaRound.actualTickPoints = 1;
  // One tick to 100, 50 ticks to 200, then 34 ticks to 302.
  assert.equal(h.run("lootRoundEstimate(etaRound, etaNow).endsAt"), h.context.etaNow + 45000 + 84 * 120000, "forecast advances terrain tiers");
  h.context.etaRound.defenderDamages = 100;
  assert.equal(h.run("lootRoundEstimate(etaRound, etaNow)"), null, "tied damage has no forecast");
  h.context.etaRound.defenderDamages = 200; h.context.etaRound.defenderPoints = 299; h.context.etaRound.attackerPoints = 0; h.context.etaRound.actualTickPoints = 3;
  assert.equal(h.run("lootRoundEstimate(etaRound, etaNow).endsAt"), h.context.etaNow + 45000, "defender leader forecast");
  h.context.etaRound.actualTickPoints = 2;
  assert.equal(h.run("lootRoundEstimate(etaRound, etaNow)"), null, "unknown tick rules fail closed");
  h.context.etaRound.actualTickPoints = 3; h.context.etaRound.isActive = false;
  assert.equal(h.run("lootRoundEstimate(etaRound, etaNow)"), null, "ended round has no forecast");
  h.context.etaRound.isActive = true; h.context.etaRound.nextTickAt = "invalid";
  assert.equal(h.run("lootRoundEstimate(etaRound, etaNow)"), null, "missing timing has no forecast");
  assert.equal(snapshot.items.length, 4, "both round and battle scopes return matching legendary/mythic targets");
  assert(snapshot.items.every(item => Number.isFinite(item.roundEstimate?.endsAt) && Number.isFinite(item.roundEstimate?.observedAt)), "both loot scopes carry current round timing through worker storage");
  assert.equal(snapshot.items[0].regionName, "Paris");
  assert.equal(snapshot.items[0].damage, 500000);
  h.alarm("we-ago-loot-radar-poll"); await h.flush(); assert.equal(h.requests.length, requestCount, "60s live/ranking caches reused");
  assert.equal((await h.message({ type: "WE_AGO_LOOT_RADAR_SAVE", settings: { legendaryDamage: -1, mythicDamage: null } })).ok, false);
  assert.equal((await h.message({ type: "WE_AGO_LOOT_RADAR_GET" }, "https://example.com/")).ok, false);
  const popup = "chrome-extension://test/popup.html";
  assert.equal((await h.message({ type: "WE_AGO_FEATURES_SAVE", features: { lootRadar: false } }, popup)).ok, true);
  await h.flush(); assert.equal(h.alarms.has("we-ago-loot-radar-poll"), false);
  h.alarm("we-ago-loot-radar-poll"); await h.flush(); assert.equal(h.requests.length, requestCount, "disabled feature makes no future loot reads");
  assert.equal((await h.message({ type: "WE_AGO_LOOT_RADAR_GET" })).data.items.length, 0);
  const restarted = worker(h.storage); await restarted.flush();
  assert.equal((await restarted.message({ type: "WE_AGO_LOOT_RADAR_GET" })).data.settings.legendaryDamage, 500001, "damage limits persist while feature disabled");
  await h.message({ type: "WE_AGO_FEATURES_SAVE", features: { lootRadar: true } }, popup); await h.flush();
  assert.equal((await h.message({ type: "WE_AGO_LOOT_RADAR_GET" })).data.items.length, 4, "re-enable needs no reload");
  await h.message({ type: "WE_AGO_LOOT_RADAR_SAVE", settings: { legendaryDamage: null, mythicDamage: null } }); await h.flush();
  assert.equal(h.alarms.has("we-ago-loot-radar-poll"), false, "no polling with both rarity limits blank");

  const pages = worker(); await pages.flush();
  const liveRanking = JSON.parse(fs.readFileSync(require("node:path").join(__dirname, "fixtures/loot-ranking-live.json"), "utf8"));
  pages.context.liveRanking = liveRanking;
  pages.context.pageClient = { query: async (procedure, input) => {
    assert.equal(input.cursor, liveRanking.result.data.nextCursor, "live opaque cursor passes through unchanged");
    return { data: { items: [], nextCursor: null } };
  } };
  assert.equal((await pages.run('radarReadPages(pageClient,"battleRanking.getRanking",{},"rankings",liveRanking.result.data)')).length, liveRanking.result.data.items.length);
  for (const badCursor of [{ offset: 100 }, false, -1, 1.5]) {
    pages.context.badCursor = badCursor;
    await assert.rejects(pages.run('radarReadPages(pageClient,"battleRanking.getRanking",{},"rankings",{items:[],nextCursor:badCursor})'), error => error.responseIssue === "invalid cursor");
  }
  pages.context.pageClient = { query: async () => ({ data: { items: [], nextCursor: "100" } }) };
  assert.equal((await pages.run('radarReadPages(pageClient,"battleRanking.getRanking",{},"rankings",{items:[{rank:1}],nextCursor:"100"})')).length, 1, "empty terminal page may retain its cursor");
  pages.context.pageClient = { query: async () => ({ data: { items: [{ rank: 2 }], nextCursor: "100" } }) };
  await assert.rejects(pages.run('radarReadPages(pageClient,"battleRanking.getRanking",{},"rankings",{items:[{rank:1}],nextCursor:"100"})'), error => error.responseIssue === "repeated cursor" && error.partialRecords.length === 2);
  await assert.rejects(pages.run('radarReadPages(pageClient,"battleRanking.getRanking",{},"rankings",{unexpected:[]})'), error => error.responseIssue === "missing results");

  const partialLoot = worker({
    "we-ago:settings": { token: "test-token", apiProvider: "official", ttls: { live: 60, static: 300, default: 60 } },
    "we-ago:features": { bountyRadar: false, contractRadar: false, lootRadar: true },
    "we-ago:lootRadar": { legendaryDamage: 1000000, mythicDamage: null }
  });
  await partialLoot.flush();
  partialLoot.context.respond = (procedure, input) => {
    if (procedure === "battleRanking.getRanking") return { items: [{ rank: 1, value: 100, lootItem: { code: "boots5", rarity: "legendary" } }] };
    return h.context.respond(procedure, input);
  };
  partialLoot.context.respondEnvelope = (procedure, input) => procedure === "battleRanking.getRanking" && input.battleId
    ? { result: { data: { unexpected: [] } } } : null;
  await partialLoot.run("pollLootRadar()");
  assert.equal(partialLoot.storage["we-ago:lootRadarResults"].items.length, 1, "healthy round survives malformed battle rankings");
  assert.match(partialLoot.storage["we-ago:lootRadarResults"].issue, /Loot battle rankings: invalid response \(missing results\)/);
  partialLoot.context.respondEnvelope = (procedure, input) => procedure === "battleRanking.getRanking" && input.battleId
    ? { error: { data: { httpStatus: 403 } } } : null;
  for (const key of Object.keys(partialLoot.storage)) if (key.startsWith("we-ago:cache:")) delete partialLoot.storage[key];
  await partialLoot.run("pollLootRadar()");
  assert.equal(partialLoot.storage["we-ago:lootRadarResults"].items.length, 1, "healthy round survives rejected battle rankings in the same wire batch");
  assert.match(partialLoot.storage["we-ago:lootRadarResults"].issue, /Loot battle rankings: API access denied/);
  partialLoot.context.respondEnvelope = () => null;
  partialLoot.context.respond = (procedure, input) => {
    if (procedure === "battleRanking.getRanking") return {
      items: [{ rank: input.cursor ? 2 : 1, value: 100, lootItem: { code: "boots5", rarity: "legendary" } }], nextCursor: "stalled"
    };
    return h.context.respond(procedure, input);
  };
  for (const key of Object.keys(partialLoot.storage)) if (key.startsWith("we-ago:cache:")) delete partialLoot.storage[key];
  const beforeStall = partialLoot.requests.length;
  await partialLoot.run("pollLootRadar()");
  const stalled = partialLoot.storage["we-ago:lootRadarResults"];
  assert.equal(stalled.items.length, 4, "repeated cursors retain discovered targets in both scopes");
  assert.match(stalled.issue, /Loot battle rankings: partial results/);
  assert.match(stalled.issue, /Loot round rankings: partial results/);
  assert.equal(partialLoot.requests.slice(beforeStall).flatMap(request => request.procedures).filter(name => name === "battleRanking.getRanking").length, 4, "each scope stops after one repeated cursor");
  partialLoot.context.respond = (procedure, input) => {
    if (procedure === "battleRanking.getRanking") return {
      items: input.cursor ? [] : [{ rank: 1, value: 100, lootItem: { code: "boots5", rarity: "legendary" } }], nextCursor: "terminal"
    };
    return h.context.respond(procedure, input);
  };
  for (const key of Object.keys(partialLoot.storage)) if (key.startsWith("we-ago:cache:")) delete partialLoot.storage[key];
  await partialLoot.run("pollLootRadar()");
  assert.equal(partialLoot.storage["we-ago:lootRadarResults"].items.length, 2, "empty terminal pages preserve both scopes");
  assert.equal(partialLoot.storage["we-ago:lootRadarResults"].issue, "", "empty terminal cursor no longer causes a retry error");
  const oldSync = Date.now() - 600000;
  const oldAlert = { type: "HIGH_BOUNTY", battleId: "retained", roundNumber: 1, side: "attacker", rate: 5, budget: 100, damageBonusPercent: 40 };
  const oldLoot = { targetId: "old-target", battleId: "retained", scope: "battle", side: "merged", rarity: "legendary", damage: 10 };
  const retained = worker({
    "we-ago:features": { bountyRadar: true, contractRadar: false, lootRadar: true },
    "we-ago:settings": { token: "test-token", apiProvider: "official" },
    "we-ago:lootRadar": { legendaryDamage: 1000 },
    activeAlerts: [oldAlert], lastRadarSync: oldSync,
    "we-ago:lootRadarResults": { version: 2, items: [oldLoot], syncedAt: oldSync }
  });
  await retained.flush();
  assert.equal((await retained.message({ type: "WE_AGO_RADAR_GET" })).data.activeAlerts.length, 1, "old persisted radar results remain readable");
  assert.equal((await retained.run("lootRadarSnapshot()")).items.length, 1, "old persisted loot results remain readable");
  await retained.run("pollRadar()"); await retained.run("pollLootRadar()");
  assert.equal(retained.storage.activeAlerts[0].battleId, "retained", "failed scan preserves old radar result");
  assert.equal(retained.storage.activeAlerts[0].stale, true);
  assert.equal(retained.storage.lastRadarSync, oldSync, "failure does not renew the successful timestamp");
  assert.equal(retained.storage["we-ago:lootRadarResults"].items[0].targetId, "old-target", "failed scan preserves old loot result");
  assert.equal(retained.storage["we-ago:lootRadarResults"].syncedAt, oldSync);
  assert.match(retained.storage.radarIssue, /Last known/);
  let retainedNotifications = 0;
  retained.context.chrome.notifications = { create: async () => { retainedNotifications++; } };
  retained.context.retainedAlerts = retained.storage.activeAlerts;
  await retained.run('notifyRadar(retainedAlerts,{enabled:true,notifyBounty:true,minimumBounty:1,minimumDamageBonus:0})');
  assert.equal(retainedNotifications, 0, "retained data is display-only for notifications");
  const scheduling = worker(); await scheduling.flush();
  let releaseScan;
  scheduling.context.pauseScan = new Promise(resolve => { releaseScan = resolve; });
  vm.runInContext("globalThis.scanRuns = 0; globalThis.rerunEnabled = null; globalThis.slowScan = async () => { scanRuns++; if (scanRuns === 1) await pauseScan; else rerunEnabled = (await readFeatures()).bountyRadar; }; enqueueRadar(slowScan)", scheduling.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scheduling.run("scanRuns"), 1);
  for (let i = 0; i < 100; i++) scheduling.run("enqueueRadar(slowScan)");
  assert.equal(scheduling.run("pendingRadar.size"), 1, "alarm bursts produce at most one pending rerun");
  assert.equal(scheduling.run("activeReads.size"), 1, "queued radar jobs do not enter the settings write barrier");
  const saveWhileScanning = scheduling.message({ type: "WE_AGO_FEATURES_SAVE", features: { bountyRadar: true } }, popup);
  releaseScan();
  assert.equal((await saveWhileScanning).ok, true); await scheduling.flush();
  assert.equal(scheduling.run("scanRuns"), 2);
  assert.equal(scheduling.run("rerunEnabled"), true, "pending rerun reads settings after the intervening save");
  assert.equal(scheduling.run("pendingRadar.size"), 0);
  console.log("Radar searches: available contracts and bid/bonus thresholds; legendary/mythic rank loot damage cutoffs; GET/cache pagination, saved limits, authorization and independent disable/re-enable passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });


