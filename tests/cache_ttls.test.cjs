"use strict";
const assert = require("node:assert/strict");
const { harness, envelope, ok } = require("./gateway_recovery.test.cjs");
(async () => {
  const key = "we-ago:settings", h = harness("official");
  h.storage[key].ttls = { live: 45, static: 200, default: 0 };
  const settings = () => h.message({ type: "WE_AGO_SETTINGS_GET" }, true);
  assert.deepEqual(JSON.parse(JSON.stringify((await settings()).data.ttls)), { live: 90, static: 400, default: 0 });
  await h.message({ type: "WE_AGO_SETTINGS_SAVE" }, true);
  assert.equal(h.storage[key].ttlVersion, 2);
  assert.equal((await settings()).data.ttls.live, 90);
  const restarted = harness("official", h.storage);
  assert.equal((await restarted.message({ type: "WE_AGO_SETTINGS_GET" }, true)).data.ttls.live, 90);
  h.respond = () => ok(envelope({}));
  for (const [procedure, input, seconds] of [
    ["itemTrading.getPrices", {}, 120],
    ["inventory.fetchCurrentEquipment", { userId: "a".repeat(24) }, 360],
    ["round.getLastHits", { roundId: "b".repeat(24) }, 60]
  ]) {
    const query = { type: "WE_AGO_QUERY", procedure, input };
    const first = await h.message(query);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.data.expiresAt - first.data.createdAt, seconds * 1000);
    h.advance(seconds * 500 + 1);
    assert.equal((await h.message(query)).data.cached, true, "survives the old lifetime");
    h.advance(seconds * 500);
    assert.equal((await h.message(query)).data.cached, false, "expires at doubled lifetime");
  }
  console.log("Doubled TTL boundaries and legacy settings migration/save/restart passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
