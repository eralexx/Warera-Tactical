"use strict";
const assert = require("node:assert/strict"), fs = require("./runtime.cjs"), vm = require("node:vm");
const read = file => fs.readFileSync(file, "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));

async function translations() {
  const messages = new Set(), storage = new Set();
  let resolveInitial;
  const context = vm.createContext({ chrome: {
    runtime: { id: "test", onMessage: { addListener(fn) { messages.add(fn); } },
      sendMessage(message) { assert.equal(message.type, "WE_AGO_LANGUAGE_GET"); return new Promise(resolve => { resolveInitial = resolve; }); } },
    storage: { onChanged: { addListener(fn) { storage.add(fn); } } }
  } });
  vm.runInContext(read("locales/es.js"), context);
  vm.runInContext(read("i18n.js"), context);
  const i18n = context.__weAgoI18n, catalog = context.__weAgoSpanish;
  assert.equal(i18n.language, "en");
  for (const fn of messages) fn({ type: "WE_AGO_LANGUAGE_CHANGED", language: "es" }, { id: "untrusted" });
  assert.equal(i18n.language, "en", "ignore messages from another extension");
  for (const fn of messages) fn({ type: "WE_AGO_LANGUAGE_CHANGED", language: "es" }, { id: "test" });
  resolveInitial({ ok: true, data: { language: "en" } }); await i18n.ready;
  assert.equal(i18n.language, "es", "a delayed initial read cannot undo a language change");
  assert.equal(i18n.t("Settings"), "Configuración");
  assert.equal(i18n.t("New English fallback"), "New English fallback");
  assert.equal(i18n.t(), "");
  assert.equal(vm.runInContext('__weAgoI18n.t`No API price benchmark for ${"<b>{0} Health</b>"}.`', context),
    "No hay precio API de referencia para <b>{0} Health</b>.", "interpolation is opaque and never recursively translated");
  for (const [key, value] of Object.entries(catalog)) {
    assert.equal(typeof value, "string");
    assert.deepEqual((value.match(/\{\d+\}/g) || []).sort(), (key.match(/\{\d+\}/g) || []).sort(), key + " preserves placeholders");
  }
  let calls = 0;
  const unsubscribe = i18n.subscribe(() => calls++);
  i18n.setLanguage("es"); assert.equal(calls, 0, "same-language updates do not rebuild modules");
  i18n.setLanguage("en"); assert.equal(calls, 1); assert.equal(i18n.t("Settings"), "Settings");
  unsubscribe(); i18n.setLanguage("invalid"); assert.equal(calls, 1); assert.equal(i18n.language, "en");
  // Popup localization only visits explicitly marked leaves and attributes.
  const leaf = { dataset: { i18n: "Settings" } }, native = { textContent: "Settings" };
  i18n.setLanguage("es");
  const root = { documentElement: {}, querySelectorAll(selector) { return selector === "[data-i18n]" ? [leaf] : []; } };
  i18n.localize(root); assert.equal(leaf.textContent, "Configuración"); assert.equal(native.textContent, "Settings");
  assert.equal(root.documentElement.lang, "es");
  for (const fn of storage) fn({ "we-ago:language": { newValue: undefined } }, "local");
  assert.equal(i18n.language, "en", "deleted/unsupported preferences fall back to English");
}

async function worker() {
  const saved = { "we-ago:settings": { token: "secret", userId: "a".repeat(24), ttls: { live: 60 } },
    "we-ago:features": { market: false }, "we-ago:language": "unsupported" };
  const original = JSON.stringify(saved), broadcasts = [];
  let receive, notify;
  const context = vm.createContext({ console, Date, setTimeout, clearTimeout,
    fetch() { throw new Error("Unexpected network request"); },
    chrome: { storage: { local: {
      async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, saved[k]])); },
      async set(values) { Object.assign(saved, values); }, async setAccessLevel() {}
    } }, runtime: { id: "test", getURL: file => "chrome-extension://test/" + file,
      onMessage: { addListener(fn) { receive = fn; } }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
    tabs: { async query() { return [{ id: 1 }, { id: 2 }]; }, async sendMessage(id, message) { broadcasts.push({ id, message }); } },
    notifications: { async create(id, value) { notify = value; }, onClicked: { addListener() {} } },
    alarms: { async clear() {}, async get() {}, async create() {}, onAlarm: { addListener() {} } }
  } });
  vm.runInContext(read("locales/es.js"), context);
  vm.runInContext(read("background.js"), context);
  await flush();
  const message = (type, fields = {}, url = "chrome-extension://test/popup.html", id = "test") => new Promise(resolve =>
    receive({ type, ...fields }, { id, url }, resolve));
  assert.equal((await message("WE_AGO_LANGUAGE_GET", {}, "https://app.warera.io/market")).data.language, "en");
  assert.equal((await message("WE_AGO_LANGUAGE_SAVE", { language: "fr" })).error.code, "INVALID_LANGUAGE");
  assert.equal((await message("WE_AGO_LANGUAGE_SAVE", { language: "es" }, "https://app.warera.io/market")).error.code, "FORBIDDEN");
  assert.equal((await message("WE_AGO_LANGUAGE_GET", {}, "https://example.com")).error.code, "FORBIDDEN");
  assert.equal(JSON.stringify(Object.fromEntries(Object.keys(JSON.parse(original)).map(key => [key, saved[key]]))), original,
    "invalid saves and reads leave credentials and features intact");
  assert.equal((await message("WE_AGO_LANGUAGE_SAVE", { language: "es" })).data.language, "es");
  assert.equal(saved["we-ago:settings"].token, "secret"); assert.equal(saved["we-ago:features"].market, false);
  assert.equal((await message("WE_AGO_LANGUAGE_GET")).data.language, "es");
  assert.equal(broadcasts.filter(x => x.message.type === "WE_AGO_LANGUAGE_CHANGED").length, 2);
  await vm.runInContext(`notifyRadar([{ type: "HIGH_BOUNTY", battleId: "b", roundNumber: 1, side: "defender", regionName: "Health", rate: 5, budget: 100, damageBonusPercent: 20 }],
    { enabled: true, contractsEnabled: false, notifyBounty: true, minimumBounty: 1, minimumDamageBonus: 0 })`, context);
  assert.equal(notify.title, "Health · Oportunidad de recompensa", "region names stay unchanged");
  assert.match(notify.message, /1000 de daño/); assert.match(notify.message, /defensor/);
  const manifest = JSON.parse(read("manifest.json"));
  assert.deepEqual(manifest.content_scripts[1].js.filter(file => ["locales/es.js", "i18n.js"].includes(file)), ["locales/es.js", "i18n.js"]);
  console.log("Localization: catalog placeholders, fallback, safe interpolation, stale startup, authorization, persistence and Spanish notifications passed.");
}
translations().then(worker).catch(error => { console.error(error); process.exitCode = 1; });
