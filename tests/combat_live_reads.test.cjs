"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const messages = [], listeners = [], requests = [];
const location = { origin: "https://app.warera.io" }, userId = "a".repeat(24);
let payload, status = 200, resolvePending;
const window = {
  addEventListener(name, fn) { listeners.push(fn); },
  postMessage(message) { messages.push(message); },
  fetch(url, options) {
    requests.push({ url, options });
    return resolvePending === true ? new Promise(resolve => { resolvePending = resolve; }) : Promise.resolve(new Response(JSON.stringify(payload), { status }));
  }
};
const context = vm.createContext({ window, location, Date, URL, Request, Map, Set, Promise });
vm.runInContext(fs.readFileSync("content/battle_responses.js", "utf8"), context);
const subscribe = (channel, value) => listeners.forEach(fn => fn({ source: window, origin: location.origin, data: { channel, subscribe: value } }));
const flush = () => new Promise(resolve => setImmediate(resolve));
const read = async (procedure, data, input = { userId }, method = "GET") => {
  payload = { result: { data } };
  const response = await window.fetch("https://api2.warera.io/trpc/" + procedure + "?input=" + encodeURIComponent(JSON.stringify(input)), { method, headers: { authorization: "secret-token" } });
  await flush(); return response;
};
(async () => {
  subscribe("we-ago-combat-read-v1", true);
  const equipment = { ammo: "heavyAmmo", weapon: { _id: "weapon", code: "gun", state: 100, skills: { attack: 50, criticalChance: 20, secret: "private" } }, secret: "private" };
  const response = await read("inventory.fetchCurrentEquipment", equipment);
  assert.equal(response.status, 200); assert.equal(requests.length, 1, "observation makes no requests");
  assert.equal(messages.length, 1); assert.equal(messages[0].channel, "we-ago-combat-read-v1");
  assert.equal(messages[0].record.userId, userId);
  const signature = messages[0].record.signature;
  assert(signature.includes("heavyAmmo") && signature.includes("50"));
  assert(!JSON.stringify(messages).includes("private") && !JSON.stringify(messages).includes("secret-token"));
  equipment.weapon.skills.attack = 120;
  await read("inventory.fetchCurrentEquipment", equipment);
  assert.notEqual(messages.at(-1).record.signature, signature, "same code with different rolls is detectable");
  await read("inventory.equipItem", null, { userId }, "POST");
  assert.equal(messages.at(-1).record.procedure, "inventory.equipItem", "successful game-side inventory changes invalidate the loadout");
  await read("user.getUserById", { buffs: { buffCodes: ["cocain"], buffEndAt: "2026-10-23", secret: "private" }, skills: { attack: { buffsPercent: 60, debuffsPercent: 0 } }, secret: "private" });
  assert(!JSON.stringify(messages).includes("private"));
  await read("inventory.equippedItems", equipment, {});
  assert.equal(messages.at(-1).record.procedure, "inventory.equippedItems");
  assert.equal(messages.at(-1).record.signature, messages[1].record.signature, "native current-loadout reads use stable signatures");
  const beforeUnrelated = messages.length;
  await read("inventory.getById", { money: 1, items: {} });
  assert.equal(messages.length, beforeUnrelated, "routine inventory reads do not repeatedly clear estimator data");
  const beforeFailure = messages.length;
  status = 403; await read("inventory.fetchCurrentEquipment", equipment);
  assert.equal(messages.length, beforeFailure, "failed native responses cannot invalidate successful data");
  status = 200;
  subscribe("we-ago-battle-read-v1", true);
  subscribe("we-ago-combat-read-v1", false);
  await read("user.getUserById", { _id: userId, buffs: null });
  assert.equal(messages.at(-1).channel, "we-ago-battle-read-v1", "battle observation survives disabling combat");
  subscribe("we-ago-combat-read-v1", true);
  subscribe("we-ago-battle-read-v1", false);
  resolvePending = true;
  const delayed = window.fetch("https://api2.warera.io/trpc/inventory.fetchCurrentEquipment?input=%7B%7D");
  subscribe("we-ago-combat-read-v1", false);
  subscribe("we-ago-combat-read-v1", true);
  const beforeLate = messages.length;
  resolvePending(new Response(JSON.stringify({ result: { data: equipment } })));
  await delayed; await flush();
  assert.equal(messages.length, beforeLate, "old native responses cannot notify a re-enabled feature");
  console.log("Passive combat reads: gear-roll/ammo/pill change signals, no extra requests or secrets, independent subscriptions and late-response teardown passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
