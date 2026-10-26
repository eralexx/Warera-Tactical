"use strict";

const assert = require("node:assert/strict");
const { harness, query, envelope, ok } = require("./gateway_recovery.test.cjs");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function reply(url) {
  const procedures = url.pathname.split("/").pop().split(",");
  const input = JSON.parse(url.searchParams.get("input"));
  const batch = url.searchParams.get("batch") === "1";
  const data = procedures.map((procedure, index) => envelope({ procedure, input: batch ? input[index] : input }));
  return ok(batch ? data : data[0]);
}

(async () => {
  const shared = harness("official");
  shared.respond = reply;
  const results = await Promise.all([
    shared.message(query("user.getUserLite", { userId: "u", a: 1 })),
    shared.message(query("user.getUserLite", { a: 1, userId: "u" })),
    shared.message(query("gameConfig.getGameConfig")),
    shared.message({ type: "WE_AGO_BATCH", calls: [query("itemTrading.getPrices"), query("user.getUserLite", { userId: "u", a: 1 })] })
  ]);
  assert.ok(results.every(result => result.ok));
  assert.equal(shared.requests.length, 1, "separate messages compose into one GET");
  assert.equal(shared.requests[0].url.pathname.split("/").pop().split(",").length, 3);
  assert.equal(results[3].data[1].data.input.userId, "u", "original ordering survives deduplication");
  assert.equal((await shared.message(query("gameConfig.getGameConfig"))).data.cached, true);

  for (const provider of ["official", "gateway"]) {
    const full = harness(provider);
    full.respond = reply;
    const calls = Array.from({ length: 50 }, (_, n) => query("user.getUserLite", { userId: String(n) }));
    const result = await full.message({ type: "WE_AGO_BATCH", calls });
    assert.equal(result.ok, true, `${provider} accepts 50 queries`);
    assert.equal(full.requests.length, 1, `${provider} sends 50 compact queries in one GET`);
    assert.equal(full.requests[0].url.pathname.split("/").pop().split(",").length, 50);
    assert.deepEqual(Array.from(result.data, entry => entry.data.input.userId), calls.map(call => call.input.userId));
    const cached = await full.message({ type: "WE_AGO_BATCH", calls });
    assert.ok(cached.data.every(entry => entry.cached));
    assert.equal(full.requests.length, 1, "50-query retry uses the cache");
    const rejected = await full.message({ type: "WE_AGO_BATCH", calls: [...calls, query()] });
    assert.equal(rejected.error.code, "INVALID_REQUEST");
    assert.match(rejected.error.message, /1 and 50/);
    assert.equal(full.requests.length, 1, "51-query message is rejected before transport");

    const overflow = harness(provider);
    overflow.respond = reply;
    const separate = await Promise.all(Array.from({ length: 51 }, (_, n) =>
      overflow.message(query("user.getUserLite", { userId: String(n) }))));
    assert.ok(separate.every(entry => entry.ok));
    assert.deepEqual(overflow.requests.map(({ url }) => url.pathname.split("/").pop().split(",").length).sort((a, b) => b - a), [50, 1],
      "shared queue splits at 50 procedures");
  }

  const bounded = harness("official");
  let active = 0, peak = 0;
  bounded.respond = async url => { active++; peak = Math.max(peak, active); await sleep(15); active--; return reply(url); };
  const many = await Promise.all(Array.from({ length: 65 }, (_, n) => bounded.message(query("user.getUserLite", { userId: String(n), padding: "x".repeat(400) }))));
  assert.ok(many.every(result => result.ok));
  assert.ok(peak <= 2);
  assert.ok(bounded.requests.length > 4, "encoded URL budget splits batches");
  bounded.requests.forEach(({ url }) => {
    assert.ok(url.href.length <= 7500);
    assert.ok(url.pathname.split("/").pop().split(",").length <= 50);
  });
  const oversized = await bounded.message(query("user.getUserLite", { userId: "u", padding: "x".repeat(8000) }));
  assert.equal(oversized.error.code, "INVALID_REQUEST");

  const ttls = harness("official");
  ttls.respond = reply;
  const ttlResults = await Promise.all([1, 300].map(ttlSeconds => ttls.message({
    ...query(), options: { ttlSeconds }
  })));
  assert.equal(ttls.requests.length, 1);
  assert.equal(ttlResults[0].data.expiresAt - ttlResults[0].data.createdAt, 1000);
  assert.equal(ttlResults[1].data.expiresAt - ttlResults[1].data.createdAt, 300000);
  ttls.advance(2000);
  assert.equal((await ttls.message({ ...query(), options: { ttlSeconds: 1 } })).data.cached, false,
    "a stricter reader never accepts an older shared cache entry");
  await ttls.message({ ...query(), options: { forceRefresh: true } });
  assert.equal(ttls.requests.length, 3, "force refresh bypasses stored data");

  const delayed = harness("official");
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  delayed.respond = async url => { started(); await gate; return reply(url); };
  const first = delayed.message(query());
  await entered;
  const duplicate = delayed.message(query());
  assert.equal((await delayed.message({ type: "WE_AGO_FEATURES_GET" })).ok, true, "settings read is responsive during a slow fetch");
  let cleared = false;
  const clear = delayed.message({ type: "WE_AGO_CACHE_CLEAR" }, true).then(result => { cleared = true; return result; });
  await sleep(20);
  assert.equal(cleared, false, "clear waits for prior cache writes");
  release();
  await Promise.all([first, duplicate, clear]);
  assert.equal(delayed.requests.length, 1, "deduplicates already dispatched reads");
  assert.equal(Object.keys(delayed.storage).filter(key => key.startsWith("we-ago:cache:")).length, 0);

  // A change-triggered refresh must wait for the older read/cache write, then
  // fetch again. Unrelated queries remain free to use the other transport slot.
  const freshness = harness("official");
  let releaseOld, markOldStarted, priceReads = 0;
  const oldStarted = new Promise(resolve => { markOldStarted = resolve; });
  const oldGate = new Promise(resolve => { releaseOld = resolve; });
  freshness.respond = async url => {
    if (!url.pathname.endsWith("itemTrading.getPrices")) return reply(url);
    const version = ++priceReads;
    if (version === 1) { markOldStarted(); await oldGate; }
    return ok(envelope({ version }));
  };
  const staleRead = freshness.message(query());
  await oldStarted;
  const refreshedRead = freshness.message({ ...query(), options: { forceRefresh: true } });
  await sleep(20);
  const followingRead = freshness.message(query());
  const unrelatedRead = await freshness.message(query("gameConfig.getGameConfig"));
  assert.equal(unrelatedRead.ok, true, "freshness ordering does not block unrelated queries");
  releaseOld();
  const [stale, refreshed, following] = await Promise.all([staleRead, refreshedRead, followingRead]);
  assert.equal(stale.data.data.version, 1);
  assert.equal(refreshed.data.data.version, 2, "forced refresh cannot join a pre-change request");
  assert.equal(following.data.data.version, 2, "later normal reads wait for the forced refresh");
  assert.equal((await freshness.message(query())).data.data.version, 2, "old reads cannot replace the refreshed cache");
  assert.equal(priceReads, 2);

  const account = harness("official");
  let releaseAccount, enteredAccount;
  const accountStarted = new Promise(resolve => { enteredAccount = resolve; });
  const accountGate = new Promise(resolve => { releaseAccount = resolve; });
  account.respond = async url => { enteredAccount(); await accountGate; return reply(url); };
  const oldRead = account.message(query());
  await accountStarted;
  const change = account.message({ type: "WE_AGO_SETTINGS_SAVE", apiProvider: "gateway" }, true);
  const newRead = account.message(query());
  await sleep(20);
  assert.equal(account.requests.length, 1, "new reads wait behind provider changes");
  releaseAccount();
  const accountResults = await Promise.all([oldRead, change, newRead]);
  assert.ok(accountResults.every(result => result.ok));
  assert.equal(accountResults[2].data.provider, "gateway");
  assert.equal(Object.values(account.storage).filter(value => value?.procedure === "itemTrading.getPrices").length, 1,
    "old provider writes finish before the cache is cleared");

  const isolated = harness("official");
  isolated.respond = url => {
    if (url.pathname.includes("gameConfig.getGameConfig")) {
      const procedures = url.pathname.split("/").pop().split(",");
      const data = procedures.map(procedure => procedure === "gameConfig.getGameConfig"
        ? { error: { data: { httpStatus: 400 } } } : envelope("healthy"));
      return ok(url.searchParams.get("batch") === "1" ? data : data[0]);
    }
    return reply(url);
  };
  const [good, bad] = await Promise.all([isolated.message(query()), isolated.message(query("gameConfig.getGameConfig"))]);
  assert.equal(good.ok, true);
  assert.equal(bad.error.code, "TRPC_ERROR");
  assert.equal(isolated.requests.length, 1, "mixed envelopes do not trigger singleton retry storms");

  for (const status of [207, 404]) {
    const mixed = harness("official");
    mixed.respond = url => {
      const data = url.pathname.split("/").pop().split(",").map(procedure => procedure === "battle.getLiveBattleData"
        ? { error: { data: { httpStatus: 404 } } } : envelope({ total: 40 }));
      return new Response(JSON.stringify(data), { status });
    };
    const [company, bonus] = await Promise.all([
      mixed.message(query("company.getById", { companyId: "c" })),
      mixed.message(query("battle.getLiveBattleData", { battleId: "b" }))
    ]);
    assert.equal(company.ok, true, "failed radar envelope cannot hide a company result");
    assert.equal(company.data.data.total, 40);
    assert.equal(bonus.ok, false);
    assert.equal(mixed.requests.length, 1);
    assert.equal((await mixed.message(query("company.getById", { companyId: "c" }))).data.cached, true);
  }

  const internal = harness("official");
  internal.respond = reply;
  await Promise.all([
    internal.message(query("company.getProductionBonus", { companyId: "c" })),
    internal.message(query("battle.getDamageBonuses", { battleId: "b" })),
    internal.message(query("mercenaryContractAuction.getPaginatedAuctions", { status: "active", limit: 50 }))
  ]);
  assert.equal(internal.requests.length, 3, "non-gateway routes are isolated by procedure to avoid batch-level rejection");

  const limited = harness("official");
  limited.respond = () => new Response("rate limited", { status: 429, headers: { "Retry-After": "2" } });
  assert.equal((await limited.message(query())).ok, false);
  const attempts = limited.requests.length;
  assert.equal((await limited.message(query("gameConfig.getGameConfig"))).ok, false);
  assert.equal(limited.requests.length, attempts, "all features respect a provider/account cooldown");
  const restarted = harness("official", limited.storage);
  restarted.respond = () => { throw Error("cooldown must survive worker restart"); };
  assert.equal((await restarted.message(query())).ok, false);
  assert.equal(restarted.requests.length, 0);
  limited.advance(2100);
  limited.respond = reply;
  assert.equal((await limited.message(query())).ok, true, "Retry-After allows recovery without token changes");

  const partial = harness("official");
  partial.respond = url => {
    const names = url.pathname.split("/").pop().split(",");
    const values = names.map(name => name === "gameConfig.getGameConfig" ? { error: { data: { httpStatus: 403 } } } : envelope({ steel: 10 }));
    return ok(names.length > 1 ? values : values[0]);
  };
  const partialCalls = [{ procedure: "itemTrading.getPrices", input: {}, ttlSeconds: 60 }, { procedure: "gameConfig.getGameConfig", input: {}, ttlSeconds: 300 }];
  assert.equal((await partial.message({ type: "WE_AGO_BATCH", calls: partialCalls })).ok, false, "default batch retains rejection contract");
  const partialCount = partial.requests.length;
  const healthy = await partial.message(query());
  assert.equal(healthy.data.cached, true, "healthy sibling persists even when its caller batch rejects");
  assert.equal(partial.requests.length, partialCount, "healthy retry makes no extra GET");
  const settled = await partial.message({ type: "WE_AGO_BATCH", calls: partialCalls, options: { settled: true } });
  assert.equal(settled.ok, true); assert.equal(settled.data[0].ok, true); assert.equal(settled.data[0].result.cached, true);
  assert.equal(settled.data[1].ok, false); assert.equal(settled.data[1].error.httpStatus, 403);
  assert.deepEqual(partial.requests.at(-1).url.pathname.split("/").pop(), "gameConfig.getGameConfig", "only failed entry reaches transport again");
  assert.equal((await partial.message({ type: "WE_AGO_BATCH", calls: partialCalls, options: { settled: "yes" } })).ok, false);

  const summaryOnly = harness("official"); summaryOnly.respond = reply;
  const profileOnly = await summaryOnly.message({ type: "WE_AGO_PLAYER_SUMMARY", includeEquipment: false });
  assert.equal(profileOnly.ok, true); assert.equal(profileOnly.data.profile.ok, true); assert.equal(profileOnly.data.equipment, undefined);
  assert.equal(summaryOnly.requests.length, 1); assert(summaryOnly.requests[0].url.pathname.endsWith("user.getUserById"));
  const fullSummary = await summaryOnly.message({ type: "WE_AGO_PLAYER_SUMMARY" });
  assert.equal(fullSummary.data.equipment.ok, true); assert.equal(fullSummary.data.profile.result.cached, true);
  assert.equal(summaryOnly.requests.length, 2, "only explicit/default equipment consumers add that read");
  assert.equal((await summaryOnly.message({ type: "WE_AGO_PLAYER_SUMMARY", includeEquipment: "false" })).ok, false);

  const routed = harness("gateway");
  routed.respond = reply;
  assert.ok((await Promise.all([
    routed.message(query()),
    routed.message(query("battleLootSummary.getByBattleAndUser", { battleId: "b", userId: "u" })),
    routed.message(query("mercenaryContract.getContracts", { battleId: "b", countryId: "c" }))
  ])).every(result => result.ok));
  assert.deepEqual(routed.hosts().sort(), ["gateway.warerastats.io", "api2.warera.io", "api5.warera.io"].sort());
  console.log("Shared API batcher: composition, deduplication, order, cache, concurrency/URL bounds, responsive reads, clear barrier, failure isolation and routing passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
