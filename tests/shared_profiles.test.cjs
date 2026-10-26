"use strict";

const assert = require("node:assert/strict");
const { harness, envelope, ok } = require("./gateway_recovery.test.cjs");
const userId = "a".repeat(24), otherId = "b".repeat(24), entityId = "c".repeat(24);
const profileCall = id => ({ procedure: "user.getUserById", input: { userId: id }, ttlSeconds: 120 });
const profiles = { type: "WE_AGO_BATCH", options: { settled: true }, calls: [profileCall(userId), profileCall(otherId)] };
const summary = { type: "WE_AGO_PLAYER_SUMMARY", includeEquipment: false };
function setup(provider) {
  const h = harness(provider, { "we-ago:features": { countryBuilds: true, bountyRadar: false, contractRadar: false, lootRadar: false } });
  const calls = [];
  h.respond = url => {
    const names = url.pathname.split("/").pop().split(","), batch = url.searchParams.get("batch") === "1";
    const input = JSON.parse(url.searchParams.get("input"));
    const values = names.map((name, index) => {
      const args = batch ? input[index] : input;
      calls.push({ name, input: args });
      if (name === "user.getUsersByCountry") return envelope({ items: [{ _id: userId }, { _id: otherId }] });
      if (name === "mu.getById") return envelope({ _id: entityId, members: [userId, otherId] });
      assert.equal(name, "user.getUserById", "all extension profile consumers use the full profile");
      return envelope({ _id: args.userId, username: "Player", level: 20,
        skills: { attack: 10, production: 0 }, buffs: { buffCodes: [], debuffCodes: [] } });
    });
    return ok(batch ? values : values[0]);
  };
  return { h, calls, count: id => calls.filter(call => call.name === "user.getUserById" && call.input.userId === id).length };
}

(async () => {
  for (const provider of ["official", "gateway"]) for (const scope of ["country", "mu"]) {
    const { h, calls, count } = setup(provider);
    const scan = { type: scope === "mu" ? "WE_AGO_GET_MU_BUILDS" : "WE_AGO_GET_COUNTRY_BUILDS",
      ...(scope === "mu" ? { muId: entityId } : { countryId: entityId }) };
    // Concurrent census, timeline/readiness/battle profiles and saved-player HUD.
    const [builds, graph, hud] = await Promise.all([h.message(scan), h.message(profiles), h.message(summary)]);
    assert.equal(builds.ok, true, JSON.stringify(builds));
    assert.equal(builds.data.all.damage, 2);
    assert.equal(graph.ok, true); assert(graph.data.every(entry => entry.ok));
    assert.equal(graph.data[0].result.data.buffs.buffCodes.length, 0);
    assert.equal(hud.data.profile.ok, true); assert.equal(hud.data.equipment, undefined);
    for (const id of [userId, otherId]) assert.equal(count(id), 1, `${provider}/${scope}: overlapping consumers fetch each profile once`);
    const reads = calls.length;
    const cached = await h.message(profiles);
    assert(cached.data.every(entry => entry.result.cached));
    assert.equal((await h.message(summary)).data.profile.result.cached, true);
    assert.equal(calls.length, reads, "later consumers reuse persisted full-profile cache");

    // A worker restart still shares the profiles; no content-session cache required.
    const restarted = harness(provider, h.storage);
    restarted.respond = () => { throw Error("fresh profiles should not reach transport after restart"); };
    assert.equal((await restarted.message(summary)).data.profile.result.cached, true);
    assert((await restarted.message(profiles)).data.every(entry => entry.result.cached));

    h.advance(121000);
    assert.equal((await h.message(scan)).data.cached, true, "build snapshot retains its independent 30-minute lifetime");
    assert.equal(calls.length, reads, "build snapshot does not poll live profiles");
    const [live, refreshedHud] = await Promise.all([h.message(profiles), h.message(summary)]);
    assert(live.data.every(entry => entry.ok)); assert.equal(refreshedHud.data.profile.ok, true);
    for (const id of [userId, otherId]) assert.equal(count(id), 2, "live consumers share one refresh after 120 seconds");
    const records = Object.values(h.storage).filter(value => value?.procedure === "user.getUserById");
    assert.equal(records.length, 2);
    assert(records.every(record => record.expiresAt - record.createdAt === 120000), "census must not extend live profile freshness");
  }
  // Either load order must share: census first and graph first.
  for (const first of ["census", "graph"]) {
    const { h, count } = setup("official");
    const scan = { type: "WE_AGO_GET_COUNTRY_BUILDS", countryId: entityId };
    assert.equal((await h.message(first === "census" ? scan : profiles)).ok, true);
    assert.equal((await h.message(first === "census" ? profiles : scan)).ok, true);
    for (const id of [userId, otherId]) assert.equal(count(id), 1, `${first} first reuses profiles`);
  }
  const equipped = harness("official");
  let equipmentReads = 0;
  equipped.respond = url => {
    const names = url.pathname.split("/").pop().split(","), batch = url.searchParams.get("batch") === "1";
    const values = names.map(name => {
      if (name === "inventory.fetchCurrentEquipment") { equipmentReads++; return envelope({ ammo: "heavyAmmo" }); }
      return envelope({ _id: userId, skills: {} });
    });
    return ok(batch ? values : values[0]);
  };
  const withEquipment = { type: "WE_AGO_PLAYER_SUMMARY", includeEquipment: true };
  const firstEquipment = await equipped.message(withEquipment);
  assert.equal(firstEquipment.data.equipment.result.expiresAt - firstEquipment.data.equipment.result.createdAt, 120000);
  assert.equal((await equipped.message(withEquipment)).data.equipment.result.cached, true);
  const forcedEquipment = await equipped.message({ ...withEquipment, forceRefresh: true });
  assert.equal(forcedEquipment.data.equipment.result.cached, false, "native loadout changes bypass a fresh equipment cache");
  assert.equal(forcedEquipment.data.profile.result.cached, false, "pill and skill state refresh together with equipment");
  assert.equal((await equipped.message({ ...withEquipment, forceRefresh: "true" })).ok, false);
  equipped.advance(121000);
  assert.equal((await equipped.message(withEquipment)).data.equipment.result.data.ammo, "heavyAmmo");
  assert.equal(equipmentReads, 3, "current equipment refreshes on changes and after 120 seconds");
  console.log("Shared full profiles and equipped combat summary: coalescing, persistence, restart cache and 120-second refresh; build snapshots retain 30-minute TTL.");
})().catch(error => { console.error(error); process.exitCode = 1; });
