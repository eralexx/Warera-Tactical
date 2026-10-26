"use strict";
const assert = require("node:assert/strict"), fs = require("./runtime.cjs"), vm = require("node:vm");
const source = fs.readFileSync("content/modules/market_undercut.js", "utf8").replace("return { sync, tick()", "return { testLoad: load, testCache: cache, testCandidate: candidate, sync, tick()");
let now = 1000, fail = false;
const requests = [];
const context = vm.createContext({ Date: { now: () => now }, chrome: { runtime: { async sendMessage(request) {
  requests.push(request); assert.equal(request.type, "WE_AGO_QUERY"); assert.equal(request.procedure, "tradingOrder.getTopOrders");
  assert.equal(request.options.ttlSeconds, 120);
  if (fail) return { ok: false };
  return { ok: true, data: { createdAt: now, expiresAt: now + 180000, data: {
    buyOrders: [{ itemCode: "steel", quantity: 10, price: .105 }], sellOrders: [{ itemCode: "steel", quantity: 10, price: .11 }]
  } } };
} } } });
vm.runInContext(fs.readFileSync("content/ui.js", "utf8") + "\n" + source, context);
(async () => {
  const module = context.__weAgoUndercut.create();
  const entry = { code: "steel", price: { getAttribute() { return "any"; } } };
  await module.testLoad("steel"); assert.equal(requests.length, 1);
  assert.equal(module.testCandidate(entry, "ask"), .11); assert.equal(module.testCandidate(entry, "bid"), .105);
  assert.equal(module.testCandidate(entry, "undercut"), .109);
  await module.testLoad("steel"); assert.equal(requests.length, 1);
  now += 120001; assert.equal(module.testCandidate(entry, "ask"), .11, "expired quote remains visible until replaced");
  fail = true; const refresh = module.testLoad("steel");
  assert.equal(module.testCandidate(entry, "ask"), .11, "quote survives pending refresh");
  await refresh; assert.equal(requests.length, 2);
  assert.equal(module.testCandidate(entry, "ask"), .11, "quote survives failed refresh");
  await module.testLoad("steel"); assert.equal(requests.length, 2, "failure backoff retained");
  module.destroy(); assert.equal(module.testCache.size, 0);
  console.log("Order helper: only book read, quote arithmetic, live TTL, cache reuse, backoff and cleanup passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
