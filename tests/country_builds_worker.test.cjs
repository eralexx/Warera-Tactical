"use strict";

const assert = require("node:assert/strict");
const fs = require("./runtime.cjs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const source = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
const prefix = "we-ago:cache:";
function harness(saved) {
  const storage = structuredClone(saved || {
    "we-ago:settings": { token: "fixture-token", apiProvider: "official" },
    "we-ago:features": { countryBuilds: true, bountyRadar: false },
    "we-ago:radarTracking": { removed: ["keep-me"] }
  });
  let listener, quota = 55000, storageFailure = false, failCountry = null;
  const requests = [], removed = [], progress = [];
  const context = vm.createContext({ crypto: webcrypto, TextEncoder, AbortSignal, setTimeout, Date,
    fetch: async (url, options) => {
      const parsed = new URL(url);
      requests.push(parsed);
      assert.equal(options.method, "GET");
      assert.equal(options.headers.Authorization, "Bearer fixture-token");
      const procedures = parsed.pathname.split("/").pop().split(",");
      const input = JSON.parse(parsed.searchParams.get("input"));
      const data = procedures.map((procedure, index) => {
        const args = procedures.length > 1 ? input[index] : input;
        if (procedure === "user.getUsersByCountry") {
          if (args.countryId === failCountry) throw new Error("fixture temporary outage");
          return { items: Array.from({ length: 3 }, (_, n) => ({ _id: args.countryId + n })) };
        }
        if (procedure === "mu.getById") return { _id: args.muId, members: Array.from({ length: 3 }, (_, n) => args.muId + n) };
        assert.equal(procedure, "user.getUserById");
        return { _id: args.userId, username: args.userId, level: 20,
          skills: { attack: 5, production: 5 }, padding: "x".repeat(11000) };
      }).map(data => ({ result: { data } }));
      return new Response(JSON.stringify(procedures.length > 1 ? data : data[0]));
    }, chrome: {
      storage: { local: {
        async get(keys) { return structuredClone(keys === null ? storage : Object.fromEntries(
          (Array.isArray(keys) ? keys : [keys]).map(key => [key, storage[key]]))); },
        async set(values) {
          if (storageFailure) throw new Error("fixture disk unavailable");
          if (Buffer.byteLength(JSON.stringify({ ...storage, ...values })) > quota) throw new Error("QUOTA_BYTES quota exceeded");
          Object.assign(storage, structuredClone(values));
        },
        async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) { removed.push(key); delete storage[key]; } },
        async setAccessLevel() {}
      } },
      runtime: { id: "fixture", getURL: name => "chrome-extension://fixture/" + name,
        onMessage: { addListener(fn) { listener = fn; } }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
      alarms: { async clear() {}, async get() {}, async create() {}, onAlarm: { addListener() {} } },
      tabs: { async query() { return []; }, async sendMessage(tab, message) { progress.push(message); } }
    }
  });
  vm.runInContext(source, context);
  return { storage, requests, removed, progress,
    set quota(value) { quota = value; }, set storageFailure(value) { storageFailure = value; },
    set failCountry(value) { failCountry = value; },
    scan(countryId, forceRefresh = false) { return new Promise(resolve => listener(
      { type: "WE_AGO_GET_COUNTRY_BUILDS", countryId, forceRefresh, requestId: countryId },
      { id: "fixture", url: "https://app.warera.io/country/" + countryId, tab: { id: 1 }, frameId: 0 }, resolve)); },
    scanMu(muId) { return new Promise(resolve => listener(
      { type: "WE_AGO_GET_MU_BUILDS", muId, requestId: muId },
      { id: "fixture", url: "https://app.warera.io/mu/" + muId, tab: { id: 1 }, frameId: 0 }, resolve)); }
  };
}

(async () => {
  const h = harness();
  const protectedState = Object.fromEntries(Object.entries(h.storage).filter(([key]) => !key.startsWith(prefix)));
  for (const country of ["Spain", "Niger", "France", "Spain"]) {
    const result = await h.scan(country);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.countryId, country);
    assert.equal(result.data.all.total, 3);
    assert.equal(result.data.all.hybrid, 3);
    assert.ok(result.data.citizens.every(user => user.username.startsWith(country)));
    assert.ok(!JSON.stringify(result.data).includes("padding"), "snapshots contain projected citizens only");
  }
  assert.ok(h.removed.length > 0, "second country triggers quota recovery");
  assert.ok(h.removed.every(key => key.startsWith(prefix)), "only disposable caches evicted");
  for (const [key, value] of Object.entries(protectedState)) assert.deepEqual(h.storage[key], value);
  let reads = h.requests.length;
  assert.equal((await h.scan("Spain")).data.cached, true);
  assert.equal(h.requests.length, reads);
  assert.equal((await h.scan("Spain", true)).data.cached, true, "completed snapshot enforces refresh cooldown");
  const restarted = harness(h.storage);
  assert.equal((await restarted.scan("Spain")).data.cached, true, "snapshot survives worker restart");
  assert.equal(restarted.requests.length, 0);

  // A response larger than the cache quota must still render fresh results.
  const oversized = harness(); oversized.quota = 4000;
  assert.equal((await oversized.scan("Large")).ok, true);
  // If even the projected snapshot cannot fit, return it with explicit cache status.
  const tiny = harness(); tiny.quota = 500;
  const uncached = await tiny.scan("Tiny");
  assert.equal(uncached.ok, true);
  assert.equal(uncached.data.cachePersisted, false);
  assert.equal(uncached.data.all.total, 3);

  const failing = harness(); failing.failCountry = "Niger";
  assert.equal((await failing.scan("Spain")).ok, true);
  const failure = await failing.scan("Niger");
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, "NETWORK_ERROR");
  assert.ok(!Object.values(failing.storage).some(entry => entry?.procedure === "country.builds" && entry.data.countryId === "Niger"));
  failing.failCountry = null;
  assert.equal((await failing.scan("Niger", true)).ok, true, "failed country can retry without restarting worker");
  assert.equal((await failing.scan("France")).ok, true, "failure does not poison worker queue");
  const disk = harness(); disk.storageFailure = true;
  assert.equal((await disk.scan("Spain")).error.code, "STORAGE_ERROR");
  disk.storageFailure = false;
  assert.equal((await disk.scan("Spain")).ok, true);
  const mu = harness();
  const memberSummary = await mu.scanMu("Unit");
  assert.equal(memberSummary.ok, true, JSON.stringify(memberSummary));
  assert.equal(memberSummary.data.scope, "mu");
  assert.equal(memberSummary.data.all.hybrid, 3);
  assert.equal(memberSummary.data.citizens.length, 3);
  assert(!mu.requests.some(url => url.pathname.includes("getUsersByCountry")), "MU reads use the MU roster");
  assert(mu.progress.every(message => message.scope === "mu"));
  const muReads = mu.requests.length;
  assert.equal((await mu.scanMu("Unit")).data.cached, true);
  assert.equal(mu.requests.length, muReads);
  assert.equal((await mu.scan("Unit")).data.scope, "country", "country/MU IDs cannot share census cache entries");
  console.log("Country worker: consecutive scans, bounded quota recovery, protected preferences, cache/restart/cooldown, uncached results and failure/retry passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
