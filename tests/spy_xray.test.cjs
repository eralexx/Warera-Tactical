"use strict";

const assert = require("node:assert/strict"), fs = require("./runtime.cjs"), vm = require("node:vm");
const source = fs.readFileSync("content/modules/spy_xray.js", "utf8").replace(
  'globalThis.__weAgoSpyXray =', 'globalThis.testSpy = { pillState, damagePotential, population, buildKind, rowValues, sessions, pump }; globalThis.__weAgoSpyXray =');
const HOUR = 3600000, id = n => n.toString(16).padStart(24, "0");
const config = { items: { cocain: { flatStats: { debuffDurationHours: 15.5, percentAttack: 60 } },
  heavyAmmo: { flatStats: { percentAttack: 40 } }, lightAmmo: { flatStats: { percentAttack: 10 } },
  cookedFish: { flatStats: { healthRegenPercent: 20 } } }, battle: { healthCost: 10 },
  skills: { precision: { skillOverflowValue: 4 }, criticalChance: { skillOverflowValue: 4 }, armor: { softCap: 40 }, dodge: { softCap: 40 } } };
const skill = (value, extra = {}) => ({ value, level: 0, prestige: 0, ...extra });
const user = n => ({ _id: id(n), buffs: null, skills: { health: skill(100, { currentBarValue: 50, total: 100 }),
  hunger: skill(4, { currentBarValue: 2.5, total: 4 }), attack: skill(100, { level: 10, militaryRankPercent: 0, buffsPercent: 0, debuffsPercent: 0 }),
  precision: skill(50), criticalChance: skill(10), criticalDamages: skill(100), armor: skill(0), dodge: skill(0) } });
const equipment = { ammo: "heavyAmmo", weapon: { code: "sniper", skills: { attack: 130, criticalChance: 20 } },
  helmet: { code: "helmet4", skills: { criticalDamages: 90 } }, gloves: { code: "gloves4", skills: { precision: 25 } },
  chest: { code: "chest4", skills: { armor: 30 } }, pants: { code: "pants4", skills: { armor: 30 } }, boots: { code: "boots4", skills: { dodge: 25 } } };
class Element {
  get textContent() { return (this._text ?? "") + (this.children ?? []).map(node => node.textContent).join(""); }
  set textContent(value) { this._text = value; this.children = []; }
  constructor(tag = "span", text = "") { this.tagName = tag.toUpperCase(); this.textContent = text; this.dataset = {}; this.attributes = {}; this.children = []; this.listeners = {}; this.visible = true; this.style = { setProperty() {} }; }
  setAttribute(key, value) { this.attributes[key] = value; if (key === "class") this.className = value; }
  getAttribute(key) { return this.attributes[key]; }
  append(...nodes) { for (const node of nodes) { node.remove(); this.children.push(node); node.parentElement = this; } }
  replaceChildren(...nodes) { for (const node of this.children) node.parentElement = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parentElement) { const a = this.parentElement.children; a.splice(a.indexOf(this), 1); this.parentElement = null; } }
  get nextElementSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1]; }
  get isConnected() { return this.tagName === "BODY" || Boolean(this.parentElement?.isConnected); }
  insertAdjacentElement(where, node) { assert.equal(where, "afterend"); node.remove(); const p = this.parentElement; p.children.splice(p.children.indexOf(this) + 1, 0, node); node.parentElement = p; }
  getClientRects() { return this.visible ? [{}] : []; }
  getBoundingClientRect() { return { top: 0, bottom: 20, left: 0, right: 100 }; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  closest(selector) {
    if (selector.startsWith(".")) return this.className === selector.slice(1) ? this : this.parentElement?.closest(selector);
    if (selector.includes("data-we-ago")) return this.dataset.weAgo ? this : this.parentElement?.closest(selector);
    if (selector.includes("nav,")) return null;
    if (selector.includes("table") && this.tagName === "TABLE") return this;
    return this.parentElement?.closest(selector) ?? null;
  }
}
function harness(kind = "country") {
  let now = Date.UTC(2026, 9, 21, 10), fail = false, defer = null, mismatch = false, rosterMode = "ids", partialUser = null;
  const body = new Element("body"), main = new Element("main"), table = new Element("table"); body.append(main); main.append(table);
  const links = [], messages = [];
  function add(n) { const link = new Element("a", `Player ${n}`); link.attributes.href = "/user/" + id(n); table.append(link); links.push(link); return link; }
  add(1); add(1); add(2);
  const location = { origin: "https://app.warera.io", href: `https://app.warera.io/${kind}/${id(50)}` };
  const document = { body, documentElement: new Element("html"), hidden: false,
    querySelector: () => null,
    createElement: tag => new Element(tag), createElementNS: (_ns, tag) => new Element(tag),
    querySelectorAll: selector => selector.startsWith("a[") ? links : [] };
  function response(message) { return { ok: true, data: message.calls.map(c => {
    if (c.procedure === "user.getUserById" && c.input.userId === partialUser) return { ok: false, error: { code: "HTTP_ERROR", httpStatus: 403 } };
    let data;
    if (c.procedure === "gameConfig.getGameConfig") data = config;
    if (c.procedure === "inventory.fetchCurrentEquipment") data = equipment;
    if (c.procedure === "user.getUserById") {
      data = user(parseInt(c.input.userId, 16));
      if (c.input.userId === id(1)) data.buffs = { buffCodes: ["cocain"], buffEndAt: new Date(now + HOUR).toISOString() };
      if (mismatch) data._id = id(999);
    }
    if (c.procedure === "mu.getById") data = { _id: id(50), members: [1, 2, 3].map(n => rosterMode === "ids" ? id(n)
      : rosterMode === "full" ? { user: user(n) } : { _id: id(n), skills: { attack: 10, production: 0 }, ...(rosterMode === "timeline" ? { buffs: null } : {}) }) };
    if (c.procedure === "user.getUsersByCountry") data = c.input.cursor
      ? { items: [{ user: { _id: id(3) } }, { _id: id(2) }] }
      : { items: [{ _id: id(1) }, { _id: id(2) }], nextCursor: "next" };
    return { createdAt: now, expiresAt: now + c.ttlSeconds * 1000, data: { json: data } };
  }) }; }
  const context = vm.createContext({ document, location, URL, innerHeight: 800, innerWidth: 1000,
    getComputedStyle: () => ({ display: "block", position: "static", overflowY: "visible" }),
    Date: class extends Date { static now() { return now; } },
    chrome: { runtime: { async sendMessage(message) {
      messages.push(message);
      if (defer) return new Promise(resolve => { defer.resolve = resolve; });
      if (fail) throw new Error("offline"); return response(message);
    } } }
  });
  vm.runInContext(source, context);
  function all(root = body) { return [root, ...root.children.flatMap(node => all(node))]; }
  return { context, body, table, document, links, messages, location, response, add,
    advance(ms = 1101) { now += ms; }, now: () => now, fail(v) { fail = v; }, mismatch(v) { mismatch = v; }, rosterMode(value) { rosterMode = value; }, partialUser(value) { partialUser = value; },
    defer() { defer = {}; return defer; },
    nodes(name) { return all().filter(n => n.className === "we-ago-spy-" + name); }, all };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
async function tick(h, instances, ms = 1101) { h.advance(ms); instances.forEach(i => i.sync()); await settle(); instances.forEach(i => i.sync()); }

(async () => {
  const h = harness(), t = h.context.testSpy, now = h.now();
  const base = user(1), expectedHit = 230 * 1.4 * (.5 + .5 * .75 + .75 * .3 * 1.9);
  const expected = expectedHit / (10 * 40 / 100 * 40 / 65) * (50 + 2 * 20);
  assert(Math.abs(t.damagePotential(base, equipment, config, now) - expected) < 1e-8, "independent planner fixture");
  const light = { ...equipment, ammo: "lightAmmo" };
  assert(Math.abs(t.damagePotential(base, light, config, now) / expected - 1.1 / 1.4) < 1e-8, "actual equipped ammo");
  const weaker = structuredClone(equipment); weaker.weapon.skills.attack = 10;
  assert(t.damagePotential(base, weaker, config, now) < expected, "actual item rolls, not purple replacement assumptions");
  assert.equal(t.damagePotential(base, { ...equipment, ammo: "unknown" }, config, now), null);
  assert.equal(t.damagePotential(base, { ...equipment, weapon: { state: 0, skills: {} } }, config, now), null);
  assert.equal(t.damagePotential(base, { ...equipment, ammoQuantity: 0 }, config, now), null);
  assert.equal(t.damagePotential(base, equipment, {}, now), null);
  const buffed = { ...base, buffs: { buffCodes: ["cocain"], buffEndAt: new Date(now + HOUR).toISOString() } };
  assert.equal(t.pillState(buffed, config, now).kind, "buff");
  assert.equal(t.pillState(buffed, config, now + HOUR).kind, "debuff");
  assert.equal(t.pillState(buffed, config, now + 16.5 * HOUR).kind, "ready");
  assert(Math.abs(t.damagePotential(buffed, equipment, config, now) - expected * 1.6) < 1e-8);
  assert(Math.abs(t.damagePotential(buffed, equipment, config, now + HOUR) - expected * .4) < 1e-8, "cached percent cannot outlive buff timer");
  assert.equal(t.pillState({}, config, now).kind, "unknown");
  assert.equal(t.pillState({ buffs: { buffCodes: {} } }, config, now).kind, "unknown");
  const model = t.population([buffed, base, {}], config, now);
  assert.equal(model.included, 2); assert.equal(model.data[0].buff, 1); assert.equal(model.data[0].ready, 1);
  assert.equal(model.data.find(p => p.at === now + HOUR).debuff, 1);
  assert.equal(model.data.at(-1).ready, 2, "no future pills manufactured");
  const eco = { ...buffed, skills: { ...buffed.skills, production: { level: 100 } } };
  const hybrid = { ...buffed, skills: { ...buffed.skills, production: { level: 10 } } };
  assert.equal(t.buildKind(eco), "eco"); assert.equal(t.buildKind(hybrid), "hybrid"); assert.equal(t.buildKind(buffed), "damage");
  const filtered = t.population([eco, hybrid, buffed, {}], config, now);
  assert.equal(filtered.included, 2); assert.equal(filtered.data[0].buff, 2, "active Eco buffs do not enter the timeline");
  const session = { profiles: new Map(), equipment: new Map([[id(1), { data: equipment, expiresAt: now + 60000 }]]), config: { data: config, expiresAt: now + 60000 } };
  for (const [player, expectedTimers] of [[eco, 0], [hybrid, 1], [buffed, 1], [base, 0]]) {
    session.profiles.set(id(1), { data: player, expiresAt: now + 60000 });
    const values = t.rowValues(session, id(1));
    assert.equal(values.filter(value => value.kind).length, expectedTimers);
    assert(!values.some(value => value.text === "Ready"), "no Ready row label");
  }
  const roster = Array.from({ length: 500 }, (_, n) => ({ ...user(n + 1), buffs: {
    buffCodes: ["cocain"], buffEndAt: new Date(now + (n % 120 - 30) * 60000).toISOString()
  } }));
  const largePopulation = t.population(roster, config, now);
  for (const point of largePopulation.data) {
    const expected = { buff: 0, debuff: 0, ready: 0 };
    for (const player of roster) {
      const end = Date.parse(player.buffs.buffEndAt);
      expected[point.at < end ? "buff" : point.at < end + 15.5 * HOUR ? "debuff" : "ready"]++;
    }
    assert.equal(point.buff, expected.buff); assert.equal(point.debuff, expected.debuff); assert.equal(point.ready, expected.ready);
  }

  const rows = h.context.__weAgoSpyXray.create(), timeline = h.context.__weAgoPillTimeline.create();
  rows.sync(); timeline.sync(); await settle(); await tick(h, [rows, timeline]); await tick(h, [rows, timeline]); await tick(h, [rows, timeline]);
  assert.equal(h.nodes("strip").length, 2); assert.equal(h.nodes("timeline").length, 1);
  const originalQuery = h.document.querySelectorAll;
  let discoveries = 0;
  h.document.querySelectorAll = selector => { discoveries++; return originalQuery(selector); };
  rows.sync({ shared: new Map() });
  discoveries = 0;
  const shared = new Map(); rows.sync({ shared }); timeline.sync({ shared });
  assert.equal(discoveries, 1, "rows and timeline share native-link discovery");
  discoveries = 0;
  for (let i = 0; i < 60; i++) { rows.tick(); timeline.tick(); }
  assert.equal(discoveries, 0, "idle ticks reuse target discovery");
  h.document.querySelectorAll = originalQuery;
  assert.equal(h.links[0].textContent, "Player 1"); assert.equal(h.links[0].attributes.href, "/user/" + id(1));
  assert(h.nodes("strip")[0].children[0].textContent.includes("50 / 100"));
  assert(h.nodes("strip")[0].children[1].textContent.includes("2.5 / 4"));
  assert(h.nodes("strip")[0].children[3].textContent.startsWith("Buff 0:"));
  assert(h.nodes("coverage")[0].textContent.startsWith("3/3 Damage/Hybrid"), "full roster, including offscreen member");
  assert.equal(h.nodes("timeline")[0].parentElement, h.table.parentElement, "inline next to citizen list");
  assert(h.messages.every(m => m.type === "WE_AGO_BATCH" && m.calls.length <= 20));
  const calls = h.messages.flatMap(m => m.calls);
  assert.equal(calls.filter(c => c.procedure === "user.getUserById" && c.input.userId === id(1)).length, 1, "rows and graph share reads");
  assert.equal(calls.filter(c => c.procedure === "inventory.fetchCurrentEquipment").length, 2, "graph does not fetch everyone's gear");
  assert(calls.every(c => c.ttlSeconds === (c.procedure === "gameConfig.getGameConfig" ? 600 : 120)));
  assert(h.nodes("line").every(n => n.attributes.d.includes("H")), "step paths at exact transitions");
  const slider = h.nodes("time-input")[0]; slider.value = "120"; slider.listeners.input();
  assert(h.nodes("readout")[0].textContent.includes("Debuffed 1"), "keyboard-accessible time inspection");
  assert(h.all().filter(n => n.className?.startsWith("we-ago-")).every(n => n.dataset.weAgo === "true"));
  rows.destroy(); assert.equal(h.nodes("strip").length, 0); assert.equal(h.nodes("timeline").length, 1);
  await tick(h, [timeline]); timeline.destroy(); assert.equal(h.context.testSpy.sessions.size, 0); assert.equal(h.nodes("timeline").length, 0);
  const before = h.messages.length; rows.sync(); timeline.sync(); await settle(); assert.equal(h.messages.length, before);

  const many = harness("battle"), manyRows = many.context.__weAgoSpyXray.create();
  for (let n = 3; n <= 35; n++) many.add(n);
  for (let i = 0; i < 8; i++) await tick(many, [manyRows]);
  assert(many.messages.some(m => m.calls.length === 20), "exercise full worker batches");
  assert(many.messages.every(m => m.calls.length <= 20));
  assert(many.nodes("strip").every(n => !n.children[2].textContent.includes("—")), "queued players and equipment all finish");
  manyRows.destroy();

  const separate = harness("mu"), separateRows = separate.context.__weAgoSpyXray.create(), separateGraph = separate.context.__weAgoPillTimeline.create();
  for (let i = 0; i < 4; i++) await tick(separate, [separateRows, separateGraph]);
  separateGraph.destroy(); const lastCall = separate.messages.length;
  await tick(separate, [separateRows], 120001);
  assert.equal(separate.nodes("timeline").length, 0); assert.equal(separate.nodes("strip").length, 2);
  assert(!separate.messages.slice(lastCall).flatMap(m => m.calls).some(c => /mu.getById|getUsersByCountry/.test(c.procedure)), "graph off stops roster polling while rows remain on");
  separateRows.destroy();

  const mu = harness("mu"), g = mu.context.__weAgoPillTimeline.create();
  for (let i = 0; i < 4; i++) await tick(mu, [g]);
  assert(mu.nodes("coverage")[0].textContent.startsWith("3/3"));
  assert(!mu.messages.flatMap(m => m.calls).some(c => c.procedure === "inventory.fetchCurrentEquipment"), "independent graph never polls equipment");
  mu.document.hidden = true; const hiddenCalls = mu.messages.length; await tick(mu, [g], 120001); assert.equal(mu.messages.length, hiddenCalls);
  mu.document.hidden = false; g.sync(); await settle();
  mu.location.href = mu.location.origin + "/market"; g.sync(); assert.equal(mu.nodes("timeline").length, 0); g.destroy();

  const battle = harness("battle"), row = battle.context.__weAgoSpyXray.create(), noGraph = battle.context.__weAgoPillTimeline.create();
  for (let i = 0; i < 3; i++) await tick(battle, [row, noGraph]);
  assert.equal(battle.nodes("strip").length, 2); assert.equal(battle.nodes("timeline").length, 0);
  assert(!battle.messages.flatMap(m => m.calls).some(c => /getUsersByCountry|mu.getById/.test(c.procedure)));
  battle.nodes("strip")[0].remove(); row.sync(); assert.equal(battle.nodes("strip").length, 2, "SPA remount");
  battle.fail(true); await tick(battle, [row], 120001); const failedCalls = battle.messages.length;
  await tick(battle, [row]); assert.equal(battle.messages.length, failedCalls, "failure backoff");
  assert(battle.nodes("strip")[0].children[0].textContent.includes("50 / 100"), "last known resources survive expiry and a failed refresh");
  assert(battle.nodes("strip")[0].children[0].title.includes("Last known")); row.destroy(); noGraph.destroy();

  const late = harness("mu"), hold = late.defer(), l = late.context.__weAgoPillTimeline.create();
  l.sync(); await settle(); l.destroy(); hold.resolve(late.response(late.messages[0])); await settle();
  assert.equal(late.nodes("timeline").length, 0); assert.equal(late.context.testSpy.sessions.size, 0);
  const invalid = harness("user"), invalidRows = invalid.context.__weAgoSpyXray.create(); invalid.mismatch(true);
  await tick(invalid, [invalidRows]); await tick(invalid, [invalidRows]);
  assert(invalid.nodes("strip")[0].children[0].textContent.includes("—"), "mismatched profile is unknown"); invalidRows.destroy();
  const partial = harness("battle"); partial.partialUser(id(2));
  const partialRows = partial.context.__weAgoSpyXray.create();
  for (let i = 0; i < 3; i++) await tick(partial, [partialRows]);
  assert(partial.nodes("strip")[0].children[0].textContent.includes("50 / 100"));
  assert(partial.nodes("strip")[1].children[0].textContent.includes("—"));
  assert.equal(partial.messages.length, 1, "a failed sibling neither discards healthy data nor triggers immediate retries");
  partialRows.destroy();
  for (const mode of ["full", "timeline", "missing-buffs"]) {
    const reused = harness("mu"); reused.rosterMode(mode);
    const graph = reused.context.__weAgoPillTimeline.create();
    for (let i = 0; i < 4; i++) await tick(reused, [graph]);
    const profiles = () => reused.messages.flatMap(message => message.calls).filter(call => call.procedure === "user.getUserById");
    assert.equal(profiles().length, mode === "missing-buffs" ? 3 : 0, "only sufficient populated roster records replace individual profiles: " + mode);
    assert(reused.nodes("coverage")[0].textContent.startsWith("3/3"));
    const visibleRows = reused.context.__weAgoSpyXray.create();
    for (let i = 0; i < 3; i++) await tick(reused, [visibleRows, graph]);
    assert.equal(profiles().length, mode === "full" ? 0 : mode === "timeline" ? 2 : 3, "visible rows fetch missing full inputs only: " + mode);
    assert.equal(reused.nodes("strip").length, 2);
    const session = [...reused.context.testSpy.sessions.values()][0];
    reused.advance(120001);
    assert([...session.profiles.values()].every(record => record.expiresAt <= reused.now()), "reused records retain the 60-second cap");
    visibleRows.destroy(); graph.destroy();
  }
  const large = harness("mu"), largeGraph = large.context.__weAgoPillTimeline.create();
  for (let i = 0; i < 3; i++) await tick(large, [largeGraph]);
  const largeSession = [...large.context.testSpy.sessions.values()][0];
  largeSession.roster = { ids: new Set(Array.from({ length: 10000 }, (_, index) => id(index + 1))), expiresAt: large.now() + 300000 };
  largeSession.profiles.clear(); largeSession.nextBatch = 0; largeSession.profileCursor = 0;
  const start = large.messages.length;
  vm.runInContext("globalThis.savedSort = Array.prototype.sort; Array.prototype.sort = () => { throw Error('roster pump must not sort'); };", large.context);
  for (let i = 0; i < 65; i++) {
    large.advance(2201); await large.context.testSpy.pump(largeSession, new Map());
  }
  vm.runInContext("Array.prototype.sort = savedSort", large.context);
  const reads = large.messages.slice(start).flatMap(message => message.calls);
  assert(large.messages.slice(start).every(message => message.calls.length <= 20), "large roster retains request budget");
  assert.equal(new Set(reads.map(call => call.input.userId)).size, 1300, "circular queue reaches new members even after early profiles expire");
  assert([...largeSession.profiles.values()].some(record => record.expiresAt <= large.now()), "live freshness is not silently extended to disguise partial coverage");
  largeGraph.destroy();
  console.log("Combat readiness, actual equipment/ammo, pill boundaries, 24h populations, full rosters, shared batching, ownership, chart inspection and independent lifecycle passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });

