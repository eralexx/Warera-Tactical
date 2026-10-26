"use strict";
const assert = require("node:assert/strict"), vm = require("node:vm");
const { harness, envelope, ok } = require("./gateway_recovery.test.cjs");
const settle = () => new Promise(resolve => setImmediate(resolve));
const base = { "we-ago:features": { countryBuilds: true, bountyRadar: false, contractRadar: false, lootRadar: false } };
function pausedWorker(procedure, stored = {}, dataFor = () => ({})) {
  const h = harness("official", { ...base, ...stored });
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  h.respond = async url => {
    const names = url.pathname.split("/").pop().split(","), batched = url.searchParams.get("batch") === "1";
    const input = JSON.parse(url.searchParams.get("input"));
    const data = names.map((name, index) => envelope(dataFor(name, batched ? input[index] : input)));
    if (names.includes(procedure)) { entered(); await waiting; }
    return ok(batched ? data : data[0]);
  };
  return { ...h, started, release, run: code => vm.runInContext(code, h.context),
    async flush() { for (let i = 0; i < 3; i++) { await vm.runInContext("queue", h.context); await vm.runInContext("radarQueue", h.context); await settle(); } } };
}
const census = { type: "WE_AGO_GET_COUNTRY_BUILDS", countryId: "Country", requestId: "r1" };
(async () => {
  for (const write of [{ type: "WE_AGO_FEATURES_SAVE", features: { countryBuilds: false } }, { type: "WE_AGO_SETTINGS_SAVE", token: "\nBearer replacement-token\n" }, { type: "WE_AGO_CACHE_CLEAR" }]) {
    const h = pausedWorker("user.getUsersByCountry", {}, () => ({ items: [{ _id: "u" }], nextCursor: "next" })); await h.flush();
    const scan = h.message(census); await h.started;
    const save = h.message(write, true); h.release();
    const [result, saved] = await Promise.all([scan, save]); await h.flush();
    assert.equal(result.error.code, "SCAN_CANCELLED"); assert.equal(saved.ok, true);
    assert.equal(h.requests.length, 1, "obsolete census stops before page 2 or profile reads");
    assert(!Object.values(h.storage).some(value => value?.procedure === "country.builds"), "cancelled scan cannot save completed summary");
    if (write.type === "WE_AGO_SETTINGS_SAVE" || write.type === "WE_AGO_CACHE_CLEAR") {
      assert.equal(Object.keys(h.storage).filter(key => key.startsWith("we-ago:cache:")).length, 0, "old reads drain before cache/account clear");
    }
  }
  const profiles = pausedWorker("user.getUserById", {}, (name, input) => name === "user.getUsersByCountry"
    ? { items: Array.from({ length: 60 }, (_, index) => ({ _id: "user" + index })) }
    : { _id: input.userId, skills: { attack: 10, production: 0 } }); await profiles.flush();
  const profileScan = profiles.message(census); await profiles.started;
  const stopProfiles = profiles.message({ type: "WE_AGO_FEATURES_SAVE", features: { countryBuilds: false } }, true);
  profiles.release(); assert.equal((await profileScan).error.code, "SCAN_CANCELLED"); assert.equal((await stopProfiles).ok, true);
  assert.equal(profiles.requests.reduce((count, request) => count + request.url.pathname.split("/").pop().split(",").filter(name => name === "user.getUserById").length, 0), 25,
    "current profile chunk may finish, but no second chunk starts");
  const early = pausedWorker("never", {}, () => ({})); await early.flush();
  const earlyScan = early.message(census);
  const earlyStop = early.message({ type: "WE_AGO_FEATURES_SAVE", features: { countryBuilds: false } }, true);
  assert.equal((await earlyScan).error.code, "SCAN_CANCELLED"); assert.equal((await earlyStop).ok, true);
  assert.equal(early.requests.length, 0, "admitted-but-not-started reads retain their pre-save scan generation");
  const denied = pausedWorker("user.getUsersByCountry", {}, () => ({ items: [{ _id: "u", skills: { attack: 10, production: 0 } }] })); await denied.flush();
  const normal = denied.message(census); await denied.started;
  const version = denied.run("scanGenerations.census");
  const unauthorized = denied.message({ type: "WE_AGO_FEATURES_SAVE", features: { countryBuilds: false } });
  const invalid = denied.message({ type: "WE_AGO_FEATURES_SAVE", features: { countryBuilds: "off" } }, true);
  assert.equal(denied.run("scanGenerations.census"), version, "unauthorized/malformed writes cannot cancel another scan");
  denied.release(); assert.equal((await normal).ok, true);
  assert.equal((await unauthorized).error.code, "FORBIDDEN"); assert.equal((await invalid).error.code, "INVALID_FEATURES");

  const radarData = (name, input) => name === "battle.getBattles" ? { items: [{ _id: "b", isActive: true }] }
    : name === "battle.getById" ? { _id: input.battleId, isActive: true, attacker: { moneyPool: 100, moneyPer1kDamages: 5 } }
      : name === "battle.getLiveBattleData" ? { round: { number: 1 } }
        : name === "battle.getDamageBonuses" ? { attacker: { totalPercent: 40 } } : [];
  const radar = pausedWorker("battle.getDamageBonuses", {
    "we-ago:features": { countryBuilds: true, bountyRadar: true, contractRadar: false, lootRadar: false },
    "we-ago:radar": { minimumBounty: 1, minimumDamageBonus: 0, notifyBounty: true }
  }, radarData); await radar.flush();
  const notifications = [];
  radar.context.chrome.notifications = { create: async (...args) => notifications.push(args) };
  radar.run("enqueueRadar(pollRadar)"); await radar.started;
  const stop = radar.message({ type: "WE_AGO_FEATURES_SAVE", features: { bountyRadar: false } }, true); radar.release();
  assert.equal((await stop).ok, true); await radar.flush();
  assert.equal(notifications.length, 0, "late bonus cannot notify after disable request");
  assert.equal(radar.storage.activeAlerts.length, 0);
  await radar.message({ type: "WE_AGO_FEATURES_SAVE", features: { bountyRadar: true } }, true); await radar.flush();
  assert.equal(notifications.length, 1, "re-enable still supports opted-in background notifications without a visible tab");

  const loot = pausedWorker("battleRanking.getRanking", {
    "we-ago:features": { countryBuilds: true, bountyRadar: false, contractRadar: false, lootRadar: true },
    "we-ago:lootRadar": { legendaryDamage: 100, mythicDamage: null }
  }, (name, input) => name === "battleRanking.getRanking" ? { items: [{ rank: 1, value: 10, lootItem: { code: "tank", rarity: "legendary" } }], nextCursor: "next" }
    : name === "gameConfig.getGameConfig" ? { items: {} } : radarData(name, input)); await loot.flush();
  loot.run("enqueueRadar(pollLootRadar)"); await loot.started;
  const stopLoot = loot.message({ type: "WE_AGO_FEATURES_SAVE", features: { lootRadar: false } }, true); loot.release();
  assert.equal((await stopLoot).ok, true); await loot.flush();
  assert.equal(loot.requests.filter(request => request.url.pathname.includes("battleRanking.getRanking")).length, 1, "loot cancellation stops cursor pagination");
  assert.equal(loot.storage["we-ago:lootRadarResults"].items.length, 0, "late rankings cannot publish targets");
  console.log("Scan cancellation: census pages, profile stages, account/cache barriers, authorization, late radar/loot results and notification re-enable passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
