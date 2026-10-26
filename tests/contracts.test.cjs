"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const battleId = "a".repeat(24), muId = "b".repeat(24);
let now = Date.now(), changes, payload, pending, calls = 0;
const listeners = new Set(), messages = [];
const location = { origin: "https://app.warera.io", pathname: "/battle/" + battleId };
const window = {
  addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn),
  postMessage(data) { messages.push(data); for (const fn of [...listeners]) fn({ source: window, origin: location.origin, data }); },
  fetch() { calls++; return pending ? new Promise(resolve => { pending = resolve; }) : Promise.resolve(new Response(JSON.stringify(payload))); }
};
const context = vm.createContext({ window, location, URL, Request, Map, Set, Promise, Date: class extends Date { static now() { return now; } },
  chrome: { storage: { local: { get: async () => ({ "we-ago:features": { fullBurst: true } }) },
    onChanged: { addListener: fn => { changes = fn; } } } } });
vm.runInContext(fs.readFileSync("content/battle_responses.js", "utf8"), context);
vm.runInContext(fs.readFileSync("content/contracts.js", "utf8"), context);
const flush = () => new Promise(resolve => setImmediate(resolve));
const url = "https://api5.warera.io/trpc/mercenaryContract.getActiveForBattle?batch=1";
const options = { method: "POST", body: JSON.stringify({0:{json:{battleId,muId}}}), headers: { Authorization: "secret" } };
const get = () => context.__weAgoContracts.get(battleId, muId);
const toggle = fullBurst => changes({ "we-ago:features": { newValue: { fullBurst } } }, "local");
(async () => {
  await flush();
  payload = [{result:{data:{json:null}}}];
  await window.fetch(url,options); await flush();
  assert.equal(get(), null, "native confirmed absence is zero, not unavailable");
  const contract = { battle: battleId, mu: {_id:muId,private:"hidden"}, status:"active", forCountrySide:"defender",
    moneyPer1kDamages:.5,minimumDamage:10000,currentDamages:9000,secret:"hidden" };
  payload = [{result:{data:{json:contract}}}];
  await window.fetch(url,options); await flush();
  assert.equal(get().moneyPer1kDamages,.5); assert.equal(get().mu,muId);
  assert(!JSON.stringify(messages).includes("hidden") && !JSON.stringify(messages).includes("secret"));
  assert.equal(context.__weAgoContracts.get(battleId,"c".repeat(24)),undefined);
  now += 120001; assert.equal(get(),undefined,"expired values stay unknown");
  toggle(false); assert.equal(get(),undefined);
  const before = messages.length; await window.fetch(url,options); await flush();
  assert.equal(messages.length,before,"disabled feature does not observe");
  toggle(true); pending = true;
  const delayed = window.fetch(url,options);
  toggle(false); toggle(true);
  pending(new Response(JSON.stringify(payload))); pending = false;
  await delayed; await flush(); assert.equal(get(),undefined,"ignore responses started before disable");
  await window.fetch(url,options); await flush(); assert.equal(get().minimumDamage,10000,"re-enable works");
  location.pathname = "/battle/" + "d".repeat(24);
  assert.equal(get(),undefined,"route changes reject previous battle");
  await window.fetch(url,options); await flush(); assert.equal(get(),undefined);
  assert.equal(calls,6,"observer sends no extra requests");
  console.log("Contracts: native wrapped responses, null, privacy, expiry, scope, toggle and late-response cleanup passed.");
})().catch(e=>{console.error(e);process.exitCode=1;});
