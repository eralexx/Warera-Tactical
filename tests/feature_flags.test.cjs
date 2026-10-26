"use strict";

const assert = require("node:assert/strict");
const fs = require("./runtime.cjs");
const path = require("node:path");
const vm = require("node:vm");
const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const keys = ["market", "marketUndercut", "battle", "spyXray", "pillTimeline",
  "companyAdvisor", "netSalary", "bountyRadar", "countryBuilds", "contractRadar", "lootRadar", "lootRoundTimer", "equipmentCped", "pillRoi", "fullBurst", "passiveCache"];
const flags = value => Object.fromEntries(keys.map(key => [key, value]));
const plain = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));

function worker(stored = {}) {
  const storage = { ...stored }, messages = [], alarms = new Map();
  let listener;
  const context = vm.createContext({ console, setTimeout, Date,
    fetch() { throw new Error("Unexpected network request"); },
    chrome: {
      storage: { local: {
        async get(keys) { return keys === null ? { ...storage } : Object.fromEntries(
          (Array.isArray(keys) ? keys : [keys]).map(key => [key, storage[key]])); },
        async set(values) { Object.assign(storage, values); }, async setAccessLevel() {}
      } },
      runtime: { id: "test", getURL: file => "chrome-extension://test/" + file,
        onMessage: { addListener(fn) { listener = fn; } },
        onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
      tabs: { async query() { return [{ id: 1 }]; }, async sendMessage(id, message) { messages.push(message); } },
      alarms: { async clear(key) { alarms.delete(key); }, async get(key) { return alarms.get(key); },
        async create(key, value) { alarms.set(key, value); }, onAlarm: { addListener() {} } }
    }
  });
  vm.runInContext(read("background.js"), context);
  return { storage, messages, alarms, context,
    message(message, popup = true) { return new Promise(resolve => listener(message,
      { id: "test", url: popup ? "chrome-extension://test/popup.html" : "https://app.warera.io/companies" }, resolve)); }
  };
}

function page() {
  const counts = {}, active = new Set(), listeners = new Set();
  let resolveInitial, observe, tick;
  const globals = { market: "Market", marketUndercut: "Undercut", battle: "Battle", spyXray: "SpyXray", pillTimeline: "PillTimeline",
    companyAdvisor: "CompanyAdvisor", netSalary: "NetSalary", bountyRadar: "BountyRadar", countryBuilds: "CountryBuilds",
    contractRadar: "ContractRadar", lootRadar: "LootRadar", lootRoundTimer: "LootRoundTimer", equipmentCped: "EquipmentCped", pillRoi: "PillRoi", fullBurst: "FullBurst", passiveCache: "PassiveCacheModule" };
  const context = vm.createContext({ document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    Date, setTimeout, clearTimeout, setInterval(fn) { tick = fn; return 1; }, clearInterval() {},
    chrome: { runtime: { id: "test", onMessage: {
      addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); }
    }, sendMessage(message) {
      assert.equal(message.type, "WE_AGO_FEATURES_GET");
      return new Promise(resolve => { resolveInitial = resolve; });
    } } },
    __weAgoRouteObserver: { start(fn) { observe = fn; return () => {}; } }
  });
  for (const [key, name] of Object.entries(globals)) {
    counts[key] = { created: 0, destroyed: 0, synced: 0 };
    context["__weAgo" + name] = { create() {
      assert.ok(!active.has(key), `duplicate ${key}`);
      active.add(key); counts[key].created++;
      return { sync() { assert.ok(active.has(key)); counts[key].synced++; },
        destroy() { assert.ok(active.has(key)); active.delete(key); counts[key].destroyed++; } };
    } };
  }
  vm.runInContext(read("content/main.js"), context);
  return { counts, active, context, listeners,
    initial(features) { resolveInitial({ ok: true, data: features }); },
    apply(features) { for (const fn of listeners) fn({ type: "WE_AGO_FEATURES_CHANGED", features }, { id: "test" }); },
    sync() { observe({ routeChanged: true }); tick(); }
  };
}

(async () => {
  const h = worker();
  const get = { type: "WE_AGO_FEATURES_GET" };
  const save = features => ({ type: "WE_AGO_FEATURES_SAVE", features });
  assert.deepEqual(plain((await h.message(get)).data), flags(true));
  for (const key of keys) {
    const next = { ...flags(true), [key]: false };
    assert.deepEqual(plain((await h.message(save(next))).data), next);
    assert.deepEqual(plain(h.storage["we-ago:features"]), next);
    assert.deepEqual(plain(h.messages.findLast(message => message.type === "WE_AGO_FEATURES_CHANGED").features), next);
    assert.deepEqual(plain((await worker(h.storage).message(get)).data), next, "restart persistence");
  }
  assert.equal((await h.message(save({ companyAdvisor: "false" }))).error.code, "INVALID_FEATURES");
  assert.equal((await h.message(save({ unknown: false }))).error.code, "INVALID_FEATURES");
  assert.equal((await h.message(save({ netSalary: false }), false)).error.code, "FORBIDDEN");
  const legacy = worker({ "we-ago:features": { tacticalSummary: false, market: false }, "we-ago:radar": { enabled: false } });
  const migrated = plain((await legacy.message(get)).data);
  assert.equal(migrated.spyXray, false); assert.equal(migrated.bountyRadar, false);
  assert.equal(migrated.pillTimeline, false, "timeline inherits disabled legacy X-ray preference only during migration");
  assert.equal(migrated.companyAdvisor, true); assert.equal(migrated.market, false);
  assert.equal(Object.hasOwn(migrated, "tacticalSummary"), false);
  assert.deepEqual(plain(legacy.storage["we-ago:features"]), migrated, "retired flag removed after preserving inherited preferences");
  assert.equal((await legacy.message(save({ tacticalSummary: true }))).error.code, "INVALID_FEATURES");
  await legacy.message(save({ market: true }));
  assert.equal((await legacy.message(get)).data.spyXray, false, "X-ray stays independent after migration");

  const explicit = worker({ "we-ago:features": { ...flags(false), tacticalSummary: true } });
  assert.deepEqual(plain((await explicit.message(get)).data), flags(false), "explicit preferences survive summary retirement");
  assert.deepEqual(plain(explicit.storage["we-ago:features"]), flags(false));

  // The common flag stops the worker alarm as well as the page UI. No token
  // is used: invoke alarm configuration without polling the live service.
  await h.message(save({ bountyRadar: true, contractRadar: false, lootRadar: false })); await settle();
  h.storage["we-ago:settings"] = { token: "fake-token" };
  await vm.runInContext("configureRadar()", h.context);
  assert.ok(h.alarms.has("we-ago-radar-poll"));
  await h.message(save({ bountyRadar: false }));
  assert.equal(h.alarms.has("we-ago-radar-poll"), false); assert.equal(h.alarms.has("we-ago-loot-radar-poll"), false);
  assert.equal((await h.message({ type: "WE_AGO_RADAR_GET" })).data.settings.enabled, false);
  await vm.runInContext("pollRadar()", h.context); // fetch would throw if reached
  assert.deepEqual(plain(h.storage.activeAlerts), []);
  // Saving thresholds cannot switch the feature back on.
  await h.message({ type: "WE_AGO_RADAR_SAVE", settings: { minimumBounty: 3 } });
  assert.equal((await h.message(get)).data.bountyRadar, false);
  // Older popup messages still update the same canonical flag.
  delete h.storage["we-ago:settings"];
  await h.message({ type: "WE_AGO_RADAR_SAVE", settings: { enabled: true, minimumBounty: 3 } });
  assert.equal((await h.message(get)).data.bountyRadar, true);

  const p = page();
  assert.equal(p.active.size, 0, "no module runs before preferences arrive");
  for (const key of keys) {
    const next = { ...flags(false), [key]: true };
    p.apply(next); p.sync(); p.apply(next);
    assert.deepEqual([...p.active], [key], `${key} runs independently`);
    assert.equal(p.counts[key].created, 1);
    p.apply(flags(false)); p.sync();
    assert.equal(p.active.size, 0);
    assert.equal(p.counts[key].destroyed, 1);
    p.apply(next);
    assert.equal(p.counts[key].created, 2, "re-enable without reload");
    p.apply(flags(false));
  }
  p.initial(flags(true)); await settle();
  assert.equal(p.active.size, 0, "late initial settings cannot undo a saved toggle");
  p.apply(flags(true));
  assert.equal(p.active.size, keys.length);
  p.context.__weAgoTopbar.destroy();
  assert.equal(p.active.size, 0); assert.equal(p.listeners.size, 0);

  // Every worker flag has a matching popup control and participates in save/load.
  const html = read("popup.html"), popup = read("popup.js");
  const registry = {}; vm.runInNewContext(read("shared/features.js"), registry);
  const popupKeys = registry.__weAgoFeatures.map(feature => feature.key);
  assert(popup.includes("__weAgoFeatures.map"));
  assert.deepEqual([...popupKeys].sort(), [...keys].sort());
  assert.deepEqual([...html.matchAll(/id="feature-([^"]+)"/g)].map(match => match[1]).sort(), [...keys].sort());
  assert.ok(!html.includes("feature-tacticalSummary"));
  assert.ok(!read("content/main.js").includes("WE_AGO_PLAYER_SUMMARY"), "scheduler never requests the retired HUD summary");
  assert.ok(!read("content/styles.css").includes("#we-ago-topbar"));
  assert.ok(!html.includes('id="radar-enabled"'), "one radar master control");
  console.log("Feature flag migration, persistence, authorization, radar polling, popup coverage and module lifecycle passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });

