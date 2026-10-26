"use strict";

const assert = require("node:assert/strict"), fs = require("./runtime.cjs"), vm = require("node:vm");
const read = file => fs.readFileSync(file, "utf8");
const names = { market: "Market", marketUndercut: "Undercut", battle: "Battle", countryBuilds: "CountryBuilds",
  spyXray: "SpyXray", pillTimeline: "PillTimeline", companyAdvisor: "CompanyAdvisor", netSalary: "NetSalary",
  bountyRadar: "BountyRadar", contractRadar: "ContractRadar", lootRadar: "LootRadar", lootRoundTimer: "LootRoundTimer", equipmentCped: "EquipmentCped", pillRoi: "PillRoi", fullBurst: "FullBurst" };
const moduleCount = Object.keys(names).length;
let timer, observer, message, nextTimer = 0, nextInterval = 0, scans = 0, ticks = 0, destroyed = 0;
const scheduled = new Map(), listeners = new Map(), intervals = new Map();
const location = { href: "https://app.warera.io/market" };
const document = { hidden: false,
  addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } };
const context = vm.createContext({ document, location, Date,
  setInterval(fn) { timer = fn; intervals.set(++nextInterval, fn); return nextInterval; }, clearInterval(id) { intervals.delete(id); },
  setTimeout(fn) { scheduled.set(++nextTimer, fn); return nextTimer; }, clearTimeout(id) { scheduled.delete(id); },
  addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); },
  chrome: { runtime: { id: "audit", onMessage: { addListener(fn) { message = fn; }, removeListener() {} },
    sendMessage() { return new Promise(() => {}); } } },
  __weAgoRouteObserver: { start(fn) { observer = fn; return () => {}; } } });
const passes = [];
for (const name of Object.values(names)) context["__weAgo" + name] = { create() { return {
  sync(options) { scans++; passes.push(options.shared); }, tick() { ticks++; }, destroy() { destroyed++; }
}; } };
context.__weAgoPassiveCacheModule = { create() { return { destroy() {} }; } };
vm.runInContext(read("content/main.js"), context);
assert.equal(intervals.size, 0, "no clock starts before preferences load");
const flags = { ...Object.fromEntries(Object.keys(names).map(key => [key, true])), passiveCache: false };
const apply = values => message({ type: "WE_AGO_FEATURES_CHANGED", features: values }, { id: "audit" });
apply(flags);
assert.equal(intervals.size, 1);
assert.equal(scans, moduleCount);
assert(passes.every(shared => shared === passes[0]), "dependent modules share a single discovery context");
for (let i = 0; i < 60; i++) timer();
assert.equal(scans, moduleCount, "idle minute adds zero structural syncs, previously 780");
assert.equal(ticks, moduleCount * 60, "countdowns and expiry still advance each second");
observer({ routeChanged: false }); assert.equal(scans, moduleCount * 2, "native update discovers once");
listeners.get("scroll")(); assert.equal(scheduled.size, 1);
document.hidden = true;
listeners.get("visibilitychange")();
assert.equal(intervals.size, 0, "hidden tabs stop the clock instead of waking and returning");
assert.equal(scheduled.size, 0, "hiding the tab clears queued viewport work");
const before = { scans, ticks };
for (let i = 0; i < 60; i++) { timer(); observer({ routeChanged: false }); }
assert.deepEqual({ scans, ticks }, before, "hidden mutations and timers dispatch no render work");
location.href += "/equipments";
document.hidden = false; listeners.get("visibilitychange")(); assert.equal(scans, before.scans + moduleCount);
assert.equal(intervals.size, 1, "visible tabs resume a single clock");
listeners.get("visibilitychange")(); assert.equal(intervals.size, 1);
location.href += "?page=2"; timer(); assert.equal(scans, before.scans + moduleCount * 3, "URL change reconciles before old-route tick");
for (let i = 0; i < 30; i++) { listeners.get("scroll")(); listeners.get("resize")(); }
assert.equal(scheduled.size, 1, "scroll and resize are coalesced");
const flush = () => { const pending = [...scheduled.values()]; scheduled.clear(); pending.forEach(fn => fn()); };
flush();
const afterViewport = scans;
listeners.get("input")({ target: { closest() { return true; } } }); assert.equal(scheduled.size, 0, "owned input does not rediscover");
listeners.get("input")({ target: { closest() { return null; } } });
listeners.get("change")({ target: { closest() { return null; } } });
listeners.get("toggle")({ target: { matches() { return true; } } });
assert.equal(scheduled.size, 1); flush(); assert.equal(scans, afterViewport + moduleCount);
listeners.get("scroll")(); observer({ routeChanged: false });
assert.equal(scheduled.size, 0, "native discovery consumes pending viewport discovery");
apply({ ...flags, market: false }); assert.equal(destroyed, 1);
const oldTicks = ticks; timer(); assert.equal(ticks, oldTicks + moduleCount - 1, "disabled module no longer ticks");
apply(flags); assert.equal(destroyed, 1, "re-enable creates the module without destroying others");
apply(Object.fromEntries(Object.keys(flags).map(key => [key, false])));
assert.equal(intervals.size, 0, "all-off stops clock wakeups");
apply({ ...Object.fromEntries(Object.keys(flags).map(key => [key, false])), passiveCache: true });
assert.equal(intervals.size, 0, "passive-only operation has no discovery or clock work");
listeners.get("scroll")(); listeners.get("resize")();
assert.equal(scheduled.size, 0, "passive-only operation does not schedule viewport work");
apply(flags); assert.equal(intervals.size, 1, "re-enabling a visible module resumes updates");
listeners.get("scroll")(); context.__weAgoTopbar.destroy();
assert.equal(scheduled.size, 0); assert.equal(listeners.size, 0); assert.equal(intervals.size, 0); assert.equal(destroyed, moduleCount * 2 + 1);
const end = { scans, ticks }; timer(); observer({ routeChanged: false }); flush(); assert.deepEqual({ scans, ticks }, end);

// Test the real observer, including attribute/text updates that no longer have
// an expensive 1-second discovery fallback to hide missing invalidation.
let mutation, observedOptions, deliveries = 0, id = 0, watcher;
const timeouts = new Map(), events = new Map();
const owned = { nodeType: 1, closest() { return true; }, matches() { return false; } };
const native = { nodeType: 1, closest() { return null; }, matches() { return false; } };
const obsContext = vm.createContext({ location: { href: "https://app.warera.io/" }, document: { documentElement: native },
  window: { addEventListener(name, fn) { events.set(name, fn); }, removeEventListener(name) { events.delete(name); } },
  setTimeout(fn) { timeouts.set(++id, fn); return id; }, clearTimeout(key) { timeouts.delete(key); },
  setInterval(fn) { watcher = fn; return 1; }, clearInterval() {},
  MutationObserver: class { constructor(fn) { mutation = fn; } observe(_node, options) { observedOptions = options; } disconnect() {} } });
vm.runInContext(read("content/observer.js"), obsContext);
const stop = obsContext.__weAgoRouteObserver.start(() => deliveries++);
assert(observedOptions.characterData && observedOptions.attributes);
mutation([{ target: owned, addedNodes: [], removedNodes: [] }]); assert.equal(timeouts.size, 0);
mutation([{ target: native, addedNodes: [], removedNodes: [] }]);
for (let i = 0; i < 30; i++) mutation([{ target: native, addedNodes: [native], removedNodes: [] }]);
assert.equal(timeouts.size, 2, "one debounce plus a fixed starvation deadline");
[...timeouts.values()][0](); assert.equal(deliveries, 1); assert.equal(timeouts.size, 0);
const body = { ...owned, matches(selector) { return selector === ".we-ago-country-body"; } };
mutation([{ target: body, addedNodes: [owned], removedNodes: [] }]); assert.equal(timeouts.size, 2, "owned census row replacement invalidates readiness discovery");
stop(); assert.equal(timeouts.size, 0); assert.equal(events.size, 0); watcher();
console.log("Performance scheduling: zero idle discovery, shared passes, clocks, hidden suspension, route/viewport/input invalidation, toggles and teardown passed.");
