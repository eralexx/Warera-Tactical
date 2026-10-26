"use strict";

const assert = require("node:assert/strict");
const fs = require("./runtime.cjs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const source = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
const settingsKey = "we-ago:settings", retryKey = "we-ago:gatewayRetryAt";
const settings = provider => ({ token: "test-token", userId: "a".repeat(24), apiProvider: provider,
  ttls: { live: 60, static: 300, default: 60 } });
const envelope = data => ({ result: { data } });
const ok = data => new Response(JSON.stringify(data));
function harness(provider = "gateway", stored = {}) {
  const storage = { [settingsKey]: settings(provider), "we-ago:radar": { enabled: false }, ...stored };
  const requests = [];
  let listener, respond = () => ok(envelope({ value: 1 })), now = 100000;
  const context = vm.createContext({ crypto: webcrypto, TextEncoder, AbortSignal,
    Date: { now: () => now }, setTimeout,
    fetch: async (url, options) => {
      const parsed = new URL(url);
      requests.push({ url: parsed, options });
      assert.equal(options.method, "GET");
      assert.equal(options.credentials, "omit");
      assert.equal(options.headers.Authorization, "Bearer test-token");
      assert.equal(parsed.searchParams.has("input"), true);
      if (parsed.hostname === "gateway.warerastats.io") assert.equal(options.headers["X-API-Key"], "test-token");
      return respond(parsed, options);
    }, chrome: {
      storage: { local: {
        async get(keys) { return keys === null ? { ...storage } : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, storage[key]])); },
        async set(values) { Object.assign(storage, values); },
        async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key]; },
        async setAccessLevel() {}
      } },
      runtime: { id: "test", getURL: file => "chrome-extension://test/" + file,
        onMessage: { addListener(fn) { listener = fn; } },
        onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
      alarms: { async clear() {}, async get() {}, async create() {}, onAlarm: { addListener() {} } },
      tabs: { async query() { return []; } }
    }
  });
  vm.runInContext(source, context);
  return { storage, requests, context, set respond(fn) { respond = fn; }, advance(ms) { now += ms; },
    message(message, popup = false) { return new Promise(resolve => listener(message,
      { id: "test", url: popup ? "chrome-extension://test/popup.html" : "https://app.warera.io/companies" }, resolve)); },
    hosts() { return requests.map(request => request.url.hostname); }
  };
}
const query = (procedure = "itemTrading.getPrices", input = {}) => ({ type: "WE_AGO_QUERY", procedure, input });
const gatewayHost = "gateway.warerastats.io", officialHost = "api2.warera.io";

module.exports = { harness, query, envelope, ok };

if (require.main === module) (async () => {
  // Every transport failure previously stopped the selected-provider flow.
  for (const failure of [
    () => { throw new TypeError("network unavailable"); },
    () => { throw new DOMException("timed out", "TimeoutError"); },
    ...[400, 401, 403, 404, 429, 500, 503].map(status => () => new Response("unavailable", { status })),
    () => new Response("invalid json"),
    () => ok({ unexpected: true }),
    () => ok({ error: { data: { httpStatus: 500 } } })
  ]) {
    const h = harness();
    h.respond = url => url.hostname === gatewayHost ? failure() : ok(envelope({ price: 2 }));
    const result = await h.message(query());
    assert.equal(result.ok, true);
    assert.equal(result.data.provider, "official");
    assert.deepEqual(h.hosts(), [gatewayHost, officialHost]);
    assert.equal(h.storage[settingsKey].apiProvider, "gateway");
    assert.ok(h.storage[retryKey] > 100000);
    assert.equal(h.storage["we-ago:radarAuthInvalid"], undefined);
    // Cache records the actual source, not the selected radio option.
    assert.equal((await h.message(query())).data.cached, true);
    assert.equal(h.requests.length, 2);
    await h.message(query("gameConfig.getGameConfig"));
    assert.equal(h.requests.length, 3);
    assert.equal(h.hosts()[2], officialHost);
    // Cooldown survives service-worker restart; recovery is attempted later.
    const restarted = harness("gateway", { [retryKey]: h.storage[retryKey] });
    assert.equal((await restarted.message(query())).data.provider, "official");
    assert.deepEqual(restarted.hosts(), [officialHost]);
    h.advance(61000);
    h.respond = () => ok(envelope({ price: 3 }));
    assert.equal((await h.message({ ...query(), options: { forceRefresh: true } })).data.provider, "gateway");
  }
  // Successful batches keep ordering, indexed input, and gateway provenance.
  const batch = { type: "WE_AGO_BATCH", calls: [query(), query("gameConfig.getGameConfig")] };
  const healthy = harness();
  healthy.respond = url => {
    assert.equal(url.searchParams.get("batch"), "1");
    assert.deepEqual(JSON.parse(url.searchParams.get("input")), { 0: {}, 1: {} });
    return ok([envelope("prices"), envelope("config")]);
  };
  assert.deepEqual(Array.from((await healthy.message(batch)).data, result => [result.data, result.provider]),
    [["prices", "gateway"], ["config", "gateway"]]);
  const partial = harness();
  partial.respond = url => ok(url.hostname === gatewayHost
    ? [envelope("discard"), { error: { data: { httpStatus: 500 } } }]
    : envelope("official config"));
  const recovered = await partial.message(batch);
  assert.deepEqual(Array.from(recovered.data, result => result.data), ["discard", "official config"]);
  assert.deepEqual(Array.from(recovered.data, result => result.provider), ["gateway", "official"]);
  assert.equal(partial.requests[1].url.pathname.split("/").pop(), "gameConfig.getGameConfig", "only the failed query falls back");
  // No bounce between providers, even when both are rate-limited.
  for (const provider of ["gateway", "official"]) {
    const h = harness(provider);
    h.respond = () => new Response("rate limited", { status: 429 });
    assert.equal((await h.message(query())).ok, false);
    assert.deepEqual(h.hosts(), provider === "gateway" ? [gatewayHost, officialHost] : [officialHost, gatewayHost]);
    assert.equal((await h.message({ type: "WE_AGO_SETTINGS_GET" }, true)).ok, true);
  }
  // Official auth failures do not switch providers; unsupported/api5 reads stay routed.
  const auth = harness("official");
  auth.respond = () => new Response("unauthorized", { status: 401 });
  assert.equal((await auth.message(query())).ok, false);
  assert.deepEqual(auth.hosts(), [officialHost]);
  const radar = harness("official", { "we-ago:radar": { enabled: true } });
  radar.respond = url => new Response("unavailable", { status: url.hostname === officialHost ? 429 : 401 });
  await vm.runInContext("pollRadar()", radar.context);
  assert.deepEqual(radar.hosts(), [officialHost, gatewayHost]);
  assert.notEqual(radar.storage["we-ago:radarAuthInvalid"], true);
  const routes = harness();
  await routes.message(query("battleLootSummary.getByBattleAndUser", { battleId: "b", userId: "u" }));
  routes.respond = () => ok([envelope([])]);
  await routes.message(query("mercenaryContract.getContracts", { battleId: "b", countryId: "c" }));
  assert.deepEqual(routes.hosts(), [officialHost, "api5.warera.io"]);
  // The saved Gateway selection is exercised through the real message handler.
  const saved = harness("official");
  saved.storage[retryKey] = 999999;
  assert.equal((await saved.message({ type: "WE_AGO_SETTINGS_SAVE", apiProvider: "gateway" }, true)).ok, true);
  assert.equal(saved.storage[settingsKey].token, "test-token");
  assert.equal(saved.storage[retryKey], undefined);
  assert.equal((await saved.message(query())).data.provider, "gateway");
  assert.equal((await saved.message({ type: "WE_AGO_SETTINGS_SAVE", apiProvider: "official" })).ok, false);
  assert.equal((await saved.message({ type: "WE_AGO_SETTINGS_SAVE", userId: "not-an-id" }, true)).error.code, "INVALID_INPUT");
  assert.equal((await saved.message({ type: "WE_AGO_SETTINGS_SAVE", userId: "b".repeat(24) }, true)).data.userId, "b".repeat(24));
  assert.equal(saved.storage[settingsKey].token, "test-token", "editing identity keeps the saved token");
  assert.equal((await saved.message({ type: "WE_AGO_SETTINGS_GET" }, true)).data.userId, "b".repeat(24), "identity persists through settings reads");
  console.log("Gateway recovery: transport failures, batches, cache, cooldown/restart, bounded retries, routing, settings and queue recovery passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
