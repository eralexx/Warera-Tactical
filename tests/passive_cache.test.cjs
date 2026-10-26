"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const { harness, query, envelope, ok } = require("./gateway_recovery.test.cjs");
const record = (data = { steel: 2 }) => ({ procedure: "itemTrading.getPrices", input: {}, data, receivedAt: 100000, provider: "official" });
const warm = value => ({ type: "WE_AGO_CACHE_WARM", contextRevision: 0, record: value });
const flush = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const h = harness("official");
  assert.equal((await h.message(warm(record()), true)).error.code, "FORBIDDEN");
  assert.equal((await h.message(warm({ ...record(), procedure: "inventory.fetchCurrentEquipment" }))).error.code, "INVALID_INPUT");
  assert.equal((await h.message(warm(record({ token: "secret" })))).error.code, "INVALID_INPUT");
  assert.equal((await h.message(warm({ ...record(), receivedAt: 100001 }))).error.code, "INVALID_INPUT");
  assert.equal((await h.message({ ...warm(record()), contextRevision: 4 })).error.code, "CONTEXT_CHANGED");
  assert.equal((await h.message(warm(record()))).data.warmed, true);
  assert.equal(h.requests.length, 0, "warming never starts a request");
  const hit = await h.message(query());
  assert.equal(hit.data.cached, true); assert.equal(hit.data.data.steel, 2);
  assert.equal((await h.message(warm(record({ steel: 99 })))).data.warmed, false, "fresh data is never overwritten");
  h.respond = () => ok(envelope({ steel: 3 }));
  const fresh = await h.message({ ...query(), options: { forceRefresh: true } });
  assert.equal(fresh.data.cached, false); assert.equal(fresh.data.data.steel, 3);
  assert.equal(h.requests.length, 1);
  assert.equal((await h.message(warm(record()))).data.warmed, false, "native data cannot replace fresh worker data");
  h.advance(120001);
  assert.equal((await h.message(query())).data.cached, false, "expiry follows normal GET path");

  const disabled = harness("official");
  await disabled.message(warm(record()));
  await disabled.message({ type: "WE_AGO_FEATURES_SAVE", features: { passiveCache: false } }, true);
  assert.equal((await disabled.message(warm(record()))).data.warmed, false);
  assert.equal((await disabled.message(query())).data.cached, false, "disabled warming ignores passive entries");
  assert.equal((await disabled.message({ type: "WE_AGO_FEATURES_GET" })).data.market, true, "independent preference");
  await disabled.message({ type: "WE_AGO_FEATURES_SAVE", features: { passiveCache: true } }, true);
  await disabled.message({ type: "WE_AGO_CACHE_CLEAR" }, true);
  assert.equal((await disabled.message(warm(record()))).data.warmed, true);
  assert.equal((await disabled.message({ ...query(), options: { ttlSeconds: 0 } })).data.cached, false, "zero TTL bypasses observations");

  const expanded = harness("official"), userId = "a".repeat(24), battleId = "b".repeat(24);
  for (const [procedure, input, data] of [
    ["gameStat.getEquipmentAvgByCode", { code: "gun1" }, 42],
    ["itemOffer.getItemOffers", { code: "gun1" }, { items: [] }],
    ["company.getCompanies", { userId }, { items: [] }],
    ["user.getUserById", { userId }, { _id: userId, skills: {} }],
    ["inventory.fetchCurrentEquipment", { userId }, { weapon: null }],
    ["mercenaryContract.getActiveForBattle", { battleId, muId: userId }, null],
    ["battle.getDamageBonuses", { battleId }, { attacker: 15 }],
    ["mu.getById", { muId: userId }, { _id: userId }]
  ]) {
    assert.equal((await expanded.message(warm({ ...record(data), procedure, input }))).data.warmed, true, procedure);
    const result = await expanded.message(query(procedure, input));
    assert.equal(result.data.cached, true, procedure);
    assert.deepEqual(result.data.data, data);
  }
  assert.equal(expanded.requests.length, 0, "expanded observations satisfy features without requests");
  await expanded.message(warm(record())); expanded.advance(1000);
  assert.equal((await expanded.message(warm({ ...record({ steel: 7 }), receivedAt: 101000 }))).data.warmed, true);
  assert.equal((await expanded.message(query())).data.data.steel, 7, "newer native responses refresh passive cache");
  assert.equal((await expanded.message(warm(record()))).data.warmed, false, "older replay cannot roll back data");
  assert.equal((await expanded.message(warm({ ...record({ _id: battleId }), procedure: "user.getUserById", input: { userId } }))).ok, false);

  // Execute the real MAIN observer: batched envelopes, original response,
  // credential isolation, GET-only allowlist and teardown generations.
  const messages = [], listeners = [];
  let calls = 0, clones = 0, payload, status = 200, resolvePending;
  const window = { addEventListener(_name, fn) { listeners.push(fn); }, postMessage(value) { messages.push(value); },
    fetch() { calls++; return resolvePending === true ? new Promise(resolve => { resolvePending = resolve; }) : Promise.resolve(response()); } };
  function response() { const value = new Response(JSON.stringify(payload), { status }); const clone = value.clone.bind(value); value.clone = () => { clones++; return clone(); }; return value; }
  const location = { origin: "https://app.warera.io", href: "https://app.warera.io/market" };
  const context = vm.createContext({ window, location, URL, Request, Date });
  for (const file of ["shared/passive_cache.js", "content/battle_responses.js"]) vm.runInContext(fs.readFileSync(file, "utf8"), context);
  const subscribe = value => listeners.forEach(fn => fn({ source: window, origin: location.origin, data: { channel: "we-ago-cache-warm-v1", subscribe: value } }));
  const url = "https://api2.warera.io/trpc/itemTrading.getPrices?input=%7B%7D";
  payload = envelope({ steel: 5 });
  await window.fetch(url); await flush(); assert.equal(clones, 0);
  subscribe(true);
  const original = await window.fetch(url, { headers: { Authorization: "secret" } });
  assert.equal((await original.json()).result.data.steel, 5, "immediate native body consumption remains readable");
  await flush(); assert.equal(messages.length, 1); assert.equal(messages[0].record.data.steel, 5);
  assert(!JSON.stringify(messages).includes("secret")); assert.equal(calls, 2);
  const before = messages.length;
  await window.fetch(url, { method: "POST" });
  await window.fetch(url.replace("api2", "api7"));
  await window.fetch(url.replace("itemTrading.getPrices", "inventory.fetchCurrentEquipment"));
  status = 403; await window.fetch(url); await flush(); assert.equal(messages.length, before);
  status = 200;
  payload = [envelope({ steel: 6 }), envelope({ sellOrders: [] })];
  await window.fetch("https://api2.warera.io/trpc/itemTrading.getPrices,tradingOrder.getTopOrders?batch=1&input=" + encodeURIComponent(JSON.stringify({ 0: {}, 1: { itemCode: "steel" } })));
  await flush(); assert.equal(messages.length, before + 2);
  assert.equal(messages.at(-1).record.input.itemCode, "steel");
  payload = [envelope({ json: 42 }), { error: { message: "denied" } }, envelope({ json: null })];
  const expandedBefore = messages.length;
  await window.fetch("https://api4.warera.io/trpc/gameStat.getEquipmentAvgByCode,user.getMe,mercenaryContract.getActiveForBattle?batch=1&input="
    + encodeURIComponent(JSON.stringify({ 0: { json: { code: "gun1" } }, 1: {}, 2: { json: { battleId, muId: userId } } })));
  await flush();
  assert.equal(messages.length, expandedBefore + 2);
  assert.equal(messages.at(-2).record.data, 42);
  assert.equal(messages.at(-1).record.data, null);
  await window.fetch(url.replace("api2.warera.io", "api4.warera.io.evil.example"));
  await flush(); assert.equal(messages.length, expandedBefore + 2, "lookalike origin ignored");
  resolvePending = true;
  const pending = window.fetch(url);
  subscribe(false); subscribe(true);
  const last = messages.length, previousClones = clones;
  payload = envelope({ steel: 10 }); resolvePending(response());
  await pending; await flush(); assert.equal(messages.length, last); assert.equal(clones, previousClones, "late response is not parsed");

  // Early isolated bridge starts once, then is adopted by the idle scheduler.
  const bridgeEvents = [], runtimeListeners = [], pageListeners = new Set(), forwarded = [];
  const bridgeWindow = { addEventListener(_name, fn) { pageListeners.add(fn); },
    removeEventListener(_name, fn) { pageListeners.delete(fn); }, postMessage(value) { bridgeEvents.push(value); } };
  const bridge = vm.createContext({ window: bridgeWindow, location, chrome: { runtime: { id: "test",
    onMessage: { addListener(fn) { runtimeListeners.push(fn); } } } },
    __weAgoApi: { async send(message) { forwarded.push(message); return { ok: true, data: { passiveCache: true } }; } } });
  const bridgeSource = fs.readFileSync("content/passive_cache.js", "utf8");
  vm.runInContext(fs.readFileSync("shared/passive_cache.js", "utf8"), bridge);
  vm.runInContext(bridgeSource, bridge); await flush();
  assert.equal(bridgeEvents.filter(event => event.subscribe === true).length, 1);
  vm.runInContext(bridgeSource, bridge);
  const controller = bridge.__weAgoPassiveCacheModule.create(); await flush();
  assert.equal(bridgeEvents.filter(event => event.subscribe === true).length, 1, "idle adoption does not double-subscribe");
  for (const receive of pageListeners) receive({ source: bridgeWindow, origin: location.origin, data: { channel: "we-ago-cache-warm-v1", record: record() } });
  await flush(); assert.equal(forwarded.filter(message => message.type === "WE_AGO_CACHE_WARM").length, 1);
  controller.destroy(); assert.equal(pageListeners.size, 0);
  bridge.__weAgoPassiveCacheModule.create(); await flush(); assert.equal(pageListeners.size, 1);
  runtimeListeners.forEach(fn => fn({ type: "WE_AGO_FEATURES_CHANGED", features: { passiveCache: false } }, { id: "test" }));
  assert.equal(pageListeners.size, 0);
  runtimeListeners.forEach(fn => fn({ type: "WE_AGO_FEATURES_CHANGED", features: { passiveCache: true } }, { id: "test" }));
  await flush(); assert.equal(pageListeners.size, 1);
  runtimeListeners.forEach(fn => fn({ type: "WE_AGO_CONTEXT_CHANGED" }, { id: "test" }));
  assert.equal(pageListeners.size, 1, "public ID-keyed reads survive player-only changes");
  runtimeListeners.forEach(fn => fn({ type: "WE_AGO_CONTEXT_CHANGED", connectionChanged: true }, { id: "test" }));
  assert.equal(pageListeners.size, 0);
  console.log("Passive cache: normal cache reads, forced/expired GETs, validation, independent disable/re-enable, native batch capture and late-response cleanup passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
