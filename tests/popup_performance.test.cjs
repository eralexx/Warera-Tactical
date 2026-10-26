"use strict";
const assert = require("node:assert/strict"), fs = require("./runtime.cjs"), vm = require("node:vm");
const elements = new Map(), pending = new Map(), requests = [], messages = [];
const controls = [{ disabled: false }, { disabled: false }];
const element = id => {
  if (!elements.has(id)) elements.set(id, { value: "", checked: false, open: false, style: {}, listeners: {},
    classList: { toggle() {} }, addEventListener(name, fn) { this.listeners[name] = fn; } });
  return elements.get(id);
};
const context = vm.createContext({ document: { getElementById: element, querySelectorAll: () => controls },
  chrome: { runtime: { sendMessage(message) { requests.push(message.type); messages.push(message); return new Promise(resolve => pending.set(message.type, resolve)); } } } });
vm.runInContext(fs.readFileSync("popup.js", "utf8"), context);
assert.deepEqual(requests, ["WE_AGO_RADAR_GET", "WE_AGO_FEATURES_GET", "WE_AGO_DISPLAY_GET", "WE_AGO_SETTINGS_GET"],
  "all four independent startup reads start before any response");
assert(controls.every(control => control.disabled), "saves are unavailable during initial load");
const keys = vm.runInContext("featureKeys", context);
pending.get("WE_AGO_FEATURES_GET")({ ok: true, data: Object.fromEntries(keys.map(key => [key, key !== "market"])) });
pending.get("WE_AGO_DISPLAY_GET")({ ok: true, data: { marketFontSize: 13 } });
pending.get("WE_AGO_RADAR_GET")({ ok: true, data: { settings: { minimumBounty: 7 } } });
(async () => {
  await new Promise(resolve => setImmediate(resolve));
  assert(controls.every(control => control.disabled), "a delayed final read cannot race an enabled save");
  pending.get("WE_AGO_SETTINGS_GET")({ ok: true, data: { hasToken: true, userId: "a".repeat(24), apiProvider: "official", ttls: { live: 60, static: 300, default: 60 } } });
  await new Promise(resolve => setImmediate(resolve));
  assert(controls.every(control => !control.disabled));
  assert.equal(element("feature-market").checked, false); assert.equal(element("feature-battle").checked, true);
  assert.equal(element("radar-bounty").value, 7); assert.equal(element("market-font-size").value, "13");
  assert.equal(element("market-font-preview").style.fontSize, "13px"); assert.equal(element("ttl-static").value, 300);
  assert.equal(element("player-id").value, "a".repeat(24), "saved player identity is editable without exposing the token");
  element("player-id").value = "b".repeat(24); element("token").value = "";
  element("settings-form").listeners.submit({ preventDefault() {} });
  assert.equal(messages.at(-1).type, "WE_AGO_SETTINGS_SAVE");
  assert.equal(messages.at(-1).userId, "b".repeat(24));
  assert.equal(messages.at(-1).token, undefined, "blank token preserves the existing credential when identity is edited");
  element("ttl-live").value = "23";
  pending.get("WE_AGO_SETTINGS_SAVE")({ok:true,data:{hasToken:true,userId:"b".repeat(24),apiProvider:"official",ttls:{live:60,static:300,default:60}}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element("ttl-live").value,"23","connection save cannot replace another form's unsaved cache lifetime");
  element("player-id").value = "c".repeat(24); element("api-gateway").checked = true;
  element("remove-token").listeners.click();
  pending.get("WE_AGO_SETTINGS_SAVE")({ok:true,data:{hasToken:false,userId:"b".repeat(24),apiProvider:"official",ttls:{live:60,static:300,default:60}}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element("player-id").value,"c".repeat(24),"removing a token preserves an unsaved player draft");
  assert.equal(element("api-gateway").checked,true,"removing a token preserves an unsaved provider draft");
  assert.equal(element("ttl-live").value,"23");
  console.log("Popup startup: parallel reads, preserved settings and no delayed-load/save race passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
