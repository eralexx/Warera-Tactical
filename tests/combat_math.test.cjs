"use strict";

const assert = require("node:assert/strict"), fs = require("./runtime.cjs"), vm = require("node:vm");
const path = require("node:path"), os = require("node:os"), { spawnSync } = require("./browser.cjs");
const source = fs.readFileSync("content/modules/combat_math.js", "utf8");
const context = vm.createContext({}); vm.runInContext(source, context);
const math = context.__weAgoCombatMath;
const base = { attack: 100, precision: 50, criticalChance: 10, criticalDamage: 100,
  precisionOverflowValue: 4, criticalOverflowValue: 4, pillPercentAttack: 60 };
const damage = (...args) => math.calculateExpectedDamagePerHit(...args);
const near = (a, b) => assert(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
near(damage(base, {}, null, false), 80);
near(damage({ ...base, precision: 0 }, {}, null, false), 50);
near(damage({ ...base, precision: 100, criticalChance: 100 }, {}, null, false), 200);
near(damage(base, { attack: 20, criticalChance: 10 }, { percentAttack: 20 }, true), 195.84);
near(damage({ ...base, precision: 110, criticalChance: 110 }, {}, null, false), 336);
near(damage({ ...base, attack: { value: 100, prestige: 20, militaryRankPercent: 10 } }, {}, null, false), 105.6);
near(damage({ ...base, criticalDamage: undefined, criticalDamages: { value: 100 } }, {}, null, false), 80);
assert.equal(damage({ ...base, precision: undefined }, {}, null, false), null);
assert.equal(damage(base, {}, { percentAttack: NaN }, true), null);
assert.equal(damage({ ...base, pillPercentAttack: undefined }, {}, null, true), null);
assert.equal(damage({ ...base, precision: 110, precisionOverflowValue: undefined }, {}, null, false), null);
assert.equal(damage(base, { attack: -1 }, null, false), 79.2);
const original = JSON.stringify(base); damage(base, { attack: 25 }, null, true); assert.equal(JSON.stringify(base), original);
const equipment = { weapon: { state: 100, skills: { attack: 20, criticalChance: 10 } }, helmet: { state: 50, skills: { criticalDamages: 5 } } };
assert.equal(math.equipmentSkills(equipment).criticalDamage, 5);
assert.equal(math.equipmentSkills({ weapon: { state: 0, skills: {} } }), null);
near(math.sequenceCosts(80, 195.84, 1, .01, 100).pilled, 2 / 19584 * 1000);
assert.equal(math.sequenceCosts(80, 195.84, 1, .01, 100).unbuffed, 0);
for (const hits of [0, -1, 1.5, Infinity, 1000001]) assert.equal(math.sequenceCosts(80, 100, 1, .1, hits), null);
const battleId = "000000000000000000000001", now = Date.now();
const battle = { _id: battleId, isActive: true, attacker: { moneyPer1kDamages: 3, moneyPool: 50 } };
assert.equal(math.bountyRate(battleId, "attacker", battle, []), 3);
assert.equal(math.bountyRate(battleId, "defender", battle, []), null);
for (const defender of [{ country: "country-id" }, { moneyPool: 0 }, { moneyPer1kDamages: 0 }, { moneyPool: null, moneyPer1kDamages: null }]) {
  assert.equal(math.bountyRate(battleId, "defender", { ...battle, defender }, []), 0);
}
assert.equal(math.bountyRate(battleId, "defender", { ...battle, defender: { moneyPer1kDamages: 2 } }, []), null);
assert.equal(math.bountyRate(battleId, "defender", undefined, []), null);
assert.equal(math.bountyRate(battleId, "attacker", battle, null), 3);
assert.equal(math.bountyRate("wrong", "attacker", battle, []), null);
assert.equal(math.bountyRate(battleId, "attacker", { ...battle, isActive: false }, []), null);
assert.equal(math.bountyRate(battleId, "attacker", { ...battle, attacker: { moneyPer1kDamages: 3, moneyPool: 0 } }, []), 0);
assert.equal(math.bountyRate(battleId, "attacker", { ...battle, attacker: { moneyPer1kDamages: 3, moneyPool: 1 } }, []), 1);
assert.equal(math.bountyRate(battleId, "attacker", { ...battle, attacker: { ...battle.attacker, bountyEffectiveAt: new Date(now + 100000).toISOString() } }, [], now), null);
assert.equal(math.bountyRate(battleId, "attacker", battle, [{ battle: "wrong", side: "attacker", perK: 999, remainingBudget: 9999 }]), 3);
console.log("Combat expectation, overflow, native aliases, sequence amortization and funded bounty math passed.");

assert.equal(math.equipmentSkills({ weapon: { skills: { attack: 20 } }, boots: { skills: { dodge: 40 } } }).dodge, 40);
assert.equal(math.baseSkill({ precision: { level: 2, prestige: 3 } }, { skills: { precision: { levels: { 2: { value: 60 } } } } }, "precision"), 63);
const end = now + 1000, hour = 3600000;
const pillPlayer = { skills: {}, buffs: { buffCodes: ["cocain"], buffEndAt: new Date(end).toISOString() } };
const pillConfig = { items: { cocain: { flatStats: { percentAttack: 60, debuffDurationHours: 16 } } } };
near(math.attackMultiplier(pillPlayer, pillConfig, now), 1.6);
near(math.attackMultiplier(pillPlayer, pillConfig, end), .4);
near(math.attackMultiplier(pillPlayer, pillConfig, end + 16 * hour), 1);
assert.equal(math.attackMultiplier({ skills: {} }, pillConfig), null);
const active = { battle: battleId, mu: "my-mu", status: "active", forCountrySide: "attacker", moneyPer1kDamages: 2, minimumDamage: 2000, currentDamages: 1500 };
assert.equal(math.contractRate(active, battleId, "attacker", "my-mu"), 1);
assert.equal(math.contractRate(active, battleId, "defender", "my-mu"), 0);
assert.equal(math.contractRate(active, battleId, "attacker", "other-mu"), null);
assert.equal(math.contractRate({ ...active, currentDamages: undefined }, battleId, "attacker", "my-mu"), null);
assert.equal(math.contractRate({ ...active, currentDamages: 2100 }, battleId, "attacker", "my-mu"), 0);
assert.equal(math.contractRate({ ...active, expiresAt: new Date(now - 1).toISOString() }, battleId, "attacker", "my-mu", now), 0);
assert.equal(math.contractRate(undefined, battleId, "attacker", "my-mu"), null);
assert.equal(math.contractRate(null, battleId, "attacker", "my-mu"), 0);
assert.equal(math.contractApplies(active, battleId, "attacker", "my-mu", now), true);
assert.equal(math.contractApplies(active, battleId, "defender", "my-mu", now), false);
assert.equal(math.contractApplies(active, battleId, "attacker", "other-mu", now), false);
assert.equal(math.contractApplies({...active,status:"completed"}, battleId, "attacker", "my-mu", now), false);
assert.equal(math.contractApplies({...active,expiresAt:new Date(now-1).toISOString()}, battleId, "attacker", "my-mu", now), false);
assert.equal(math.contractApplies({...active,moneyPer1kDamages:0}, battleId, "attacker", "my-mu", now), true);
const estimateData = { equipment: {}, skills: base, gear: {}, player: { buffs: null, skills: { armor: { value: 40 }, dodge: { value: 40 }, health: { total: 100 }, lootChance: { total: 10 } } },
  config: { battle: { healthCost: 10 }, skills: { armor: { softCap: 40 }, dodge: { softCap: 40 } }, items: { cookedFish: { flatStats: { healthRegenPercent: 20 } } } },
  prices: { cookedFish: .2 }, bonuses: { attacker: { totalPercent: 100 } } };
const quote = math.currentEstimate(estimateData, "attacker");
near(quote.damage, 160); near(quote.cost, .15625); near(quote.boxes, .625); near(quote.elite, .00625);
near(quote.chance, (1 - .9 ** 6.25) * 100);
assert.equal(math.currentEstimate({ ...estimateData, equipment: { ammo: "unknown" } }, "attacker").damage, null);
const noPrice = { ...estimateData, prices: {} };
assert.equal(math.currentEstimate(noPrice, "attacker").cost, null);
near(math.currentEstimate(noPrice, "attacker").boxes, .625);
const gearChange = { ...estimateData, gear: { attack: 100, armor: 40, dodge: 40 } };
const upgraded = math.currentEstimate(gearChange, "attacker");
near(upgraded.damage, 320); assert(upgraded.cost < quote.cost / 2);
console.log("Current gear, config skill levels, active effects/expiry, MU eligibility, partial rewards, food and drop expectations passed.");
const burstData = { ...estimateData, player: { ...estimateData.player, skills: { ...estimateData.player.skills,
  health: { total: 100, currentBarValue: 1 }, hunger: { total: 4, currentBarValue: 0 } } } };
const burst = math.fullBurst(burstData, "attacker");
const noFoodBurst = math.fullBurst({ ...burstData, foodCode: "none", prices: {} }, "attacker");
near(noFoodBurst.hits, 40); near(noFoodBurst.damage, 6400); near(noFoodBurst.cost, 0); const valuedBurst = math.fullBurst({ ...burstData, foodCode: "none", prices: { case1: 2, case2: 10 } }, "attacker");
near(valuedBurst.boxValue, 8); near(valuedBurst.eliteValue, .4);
assert.equal(noFoodBurst.boxValue, null);
near(noFoodBurst.boxes, 4); near(noFoodBurst.elite, .04);
near(burst.hits, 72); near(burst.damage, 11520); near(burst.cost, .8);
const filled = { ...burstData, player: { ...burstData.player, skills: { ...burstData.player.skills,
  health: { total: 100, currentBarValue: 100 }, hunger: { total: 4, currentBarValue: 4 } } } };
near(math.fullBurst(filled, "attacker").damage, burst.damage);
near(math.fullBurst({ ...burstData, prices: {} }, "attacker").damage, burst.damage);
assert.equal(math.fullBurst({ ...burstData, prices: {} }, "attacker").cost, null);
assert.equal(math.fullBurst(estimateData, "attacker"), null);
near(math.bountyRate(battleId, "attacker", battle, [], now, 50000), 50);
near(math.contractRate(active, battleId, "attacker", "my-mu", now, 11520), 1);
near(math.contractRate(active, battleId, "attacker", "my-mu", now, 100), .2);
const comparable = { code: "gun", skills: { attack: 20, criticalChance: 10 } };
const offer = (price, state, extra = {}) => ({ user: "seller", price, item: { ...comparable, state }, ...extra });
near(math.replacementUnitPrice(comparable, [offer(10, 100), offer(6, 50)], 10, "me"), .11);
near(math.replacementUnitPrice(comparable, [offer(4, 50)], 10, "me"), .088);
assert.equal(math.replacementUnitPrice(comparable, [offer(1, 100, { user: "me" }), offer(0, 0),
  offer(1, 100, { item: { code: "gun", state: 100, skills: { attack: 19, criticalChance: 10 } } })], 10, "me"), null);
const wearData = { ...burstData, equipment: { weapon: comparable, boots: { code: "boots1", skills: { dodge: 40 } } },
  gear: { dodge: 40 }, equipmentPrices: { weapon: .11, boots: .3 } };
near(math.equipmentWearPerHit(wearData), .21); // weapon .11 plus boots .3 × 1/3 non-dodge probability
near(math.fullBurst(wearData, "attacker").cost, .8 + 108 * .21);
near(math.currentEstimate(wearData, "attacker").cost, 1000 / 160 * (.21 + (10 / 2 / 3) / 20 * .2));
assert.equal(math.equipmentWearPerHit({ ...wearData, equipmentPrices: { weapon: .11 } }), null);
near(math.breakScraps("gun"), 6); near(math.breakScraps("boots1"), 2);
near(math.breakScraps("jet"), 486); assert.equal(math.breakScraps("unknown"), null);
// Exactly 10 hits and 3 dodges: 10% weapon wear, 7% armor wear,
// not one whole set. These are depreciation costs, not purchase outlays.
const tenHits = { ...wearData, equipmentPrices: { weapon: 1, boots: 1 } };
near(math.equipmentWear(tenHits, 10, 3), 17);
near(math.equipmentWear(tenHits, 10, 10), 10);
near(math.equipmentWear(tenHits, 0, 0), 0);
assert.equal(math.equipmentWear(tenHits, 10, 11), null);
const weaponUnit = math.replacementUnitPrice(comparable, [offer(100, 100)], 0, "me", 1);
near(weaponUnit, .94); // 100 gold minus 6 scraps worth 1 each, over 100 durability
near(math.equipmentWear({ ...tenHits, equipmentPrices: { weapon: weaponUnit, boots: .98 } }, 10, 3), 16.26);
near(math.replacementUnitPrice(comparable, [offer(50, 50)], 0, "me", 1), .88);
near(math.equipmentWear({ ...tenHits, equipmentPrices: { weapon: weaponUnit, boots: .98 } }, 200, 60), 325.2);

if (process.argv.includes("--math-only")) process.exit(0);
const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find(file => file && fs.existsSync(file));
assert(chrome, "Set CHROME_PATH for the local mock browser checks");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "we-ago-combat-"));
const fixture = path.join(dir, "fixture.html");
const setup = function () {
  window.testLocation = { href: "https://app.warera.io/market/equipments", origin: "https://app.warera.io" };
  window.subscriptions = []; window.postMessage = message => subscriptions.push(message);
  window.emitLoadout = (signature, userId = "000000000000000000000002") => window.dispatchEvent(new MessageEvent("message", { source: window, origin: testLocation.origin, data: { channel: "we-ago-combat-read-v1", record: { kind: "loadout", procedure: "inventory.fetchCurrentEquipment", userId, signature, receivedAt: Date.now() } } }));
  let now = Date.now(); Date.now = () => now;
  window.advance = (ms = 61000) => { now += ms; };
  window.calls = []; window.delaySummary = false; window.summaryResolves = [];
  window.delayContract = false; window.contractResolves = []; window.delayPrices = false; window.priceResolves = [];
  const player = { _id: "000000000000000000000002", mu: "000000000000000000000003", country: "country-id", buffs: null, skills: { attack: { value: 100, militaryRankPercent: 0 },
    precision: { value: 50 }, criticalChance: { value: 10 }, criticalDamages: { value: 100 }, armor: { value: 40 }, dodge: { value: 40 }, health: { total: 100 }, lootChance: { total: 10 } } };
  const equipment = { weapon: { code: "gun", state: 100, skills: { attack: 20, criticalChance: 10 } }, ammo: "heavyAmmo", boots: { code: "boots1", state: 100, skills: { dodge: 40 } } };
  window.fixtureGear = equipment; window.fixturePlayer = player;
  const config = { battle: { healthCost: 10 }, skills: { armor: { softCap: 40 }, dodge: { softCap: 40 }, precision: { skillOverflowValue: 4 }, criticalChance: { skillOverflowValue: 4 } }, items: {
    gun: { dynamicStats: { attack: [1, 100], criticalChance: [1, 50] } },
    rifle: { dynamicStats: { attack: [1, 150], criticalChance: [1, 50] } },
    cookedFish: { flatStats: { healthRegenPercent: 20 } }, bread: { flatStats: { healthRegenPercent: 10 } }, steak: { flatStats: { healthRegenPercent: 30 } }, cocain: { flatStats: { percentAttack: 60, debuffDurationHours: 16 } }, ammo: { flatStats: { percentAttack: 20 } },
    lightAmmo: { flatStats: { percentAttack: 10 } }, heavyAmmo: { flatStats: { percentAttack: 40 } } } };
  const result = data => ({ data: structuredClone(data), expiresAt: now + 60000 });
  const summary = () => ({ ok: true, data: { state: "ready", userId: player._id,
    profile: { ok: true, result: result(player) }, equipment: { ok: true, result: result(equipment) } } });
  window.chrome = { runtime: { async sendMessage(message) {
    calls.push(message);
    if (message.type === "WE_AGO_PLAYER_SUMMARY") {
      if (message.includeEquipment !== testLocation.href.includes("/battle/")) throw new Error("Unnecessary or missing equipment read");
      if (delaySummary) { const reply = summary(); return new Promise(resolve => summaryResolves.push(() => resolve(reply))); }
      if (window.failSummaryCode) return { ok: false, error: { code: window.failSummaryCode } };
      return summary();
    }
    if (window.denyEquipmentOffers && message.procedure === "itemOffer.getItemOffers") return { ok: false, error: { httpStatus: 401 } };
    if (window.denyEquipmentAverage && message.procedure === "gameStat.getEquipmentAvgByCode") return { ok: false, error: { httpStatus: 401 } };
    if (window.denyContract && message.procedure === "mercenaryContract.getActiveForBattle") return { ok: false, error: { httpStatus: 401 } };
    if (message.type !== "WE_AGO_QUERY") throw new Error("Unexpected message");
    if (window.failPrices && message.procedure === "itemTrading.getPrices") return { ok: false, error: { status: 403, code: "FORBIDDEN" } };
    if (window.failContract && message.procedure === "mercenaryContract.getActiveForBattle") return { ok: false, error: { status: 403, code: "FORBIDDEN" } };
    if (window.failBonus && message.procedure === "battle.getDamageBonuses") return { ok: false, error: { status: 403, code: "FORBIDDEN" } };
    if (window.failBounty && message.procedure === "battle.getById") return { ok: false, error: { status: 403, code: "FORBIDDEN" } };
    if (message.options.ttlSeconds !== (["gameConfig.getGameConfig", "country.getCountryById"].includes(message.procedure) ? 600 : 120)) throw new Error("Wrong TTL");
    let data;
    if (message.procedure === "gameConfig.getGameConfig") data = config;
    else if (message.procedure === "itemTrading.getPrices") data = { case1: 2, case2: 10, bread: .1, steak: .5, scraps: window.scrapPrice || 0, cocain: 1, cookedFish: .2, ammo: .01, lightAmmo: .005, heavyAmmo: .02 };
    else if (message.procedure === "battle.getById") data = { _id: message.input.battleId, isActive: true,
      attacker: { moneyPer1kDamages: 3, moneyPool: 100 }, defender: { moneyPer1kDamages: .25, moneyPool: 100 } };
    else if (message.procedure === "battle.getDamageBonuses") data = { attacker: { totalPercent: 100 }, defender: { totalPercent: 0 } };
    else if (message.procedure === "mercenaryContract.getActiveForBattle") data = { battle: message.input.battleId, mu: message.input.muId, forCountrySide: "attacker", status: "active", moneyPer1kDamages: 2, minimumDamage: 2000, currentDamages: 1500 };
    else if (message.procedure === "gameStat.getEquipmentAvgByCode") data = 10;
    else if (message.procedure === "country.getCountryById") data = { taxes: { market: 10 } };
    else if (message.procedure === "itemOffer.getItemOffers") data = { items: window.noEquipmentOffers ? [] : [{ user: "seller", price: window.equipmentPrice || 0, item: { code: message.input.itemCode, state: 100, skills: message.input.minSkills } }] };
    else throw new Error("Unexpected procedure");
    if (window.noBounty && message.procedure === "battle.getById") data.defender = { country: "country-id" };
    if (window.noContract && message.procedure === "mercenaryContract.getActiveForBattle") data = null;
    const reply = { ok: true, data: result(data) };
    if (window.delayContract && message.procedure === "mercenaryContract.getActiveForBattle") return new Promise(resolve => contractResolves.push(() => resolve(reply)));
    if (window.delayPrices && message.procedure === "itemTrading.getPrices") return new Promise(resolve => priceResolves.push(() => resolve(reply)));
    return reply;
  } } };
  const icons = { attack: "M11,9H9V2", criticalChance: "M4.35 21H21" };
  const stat = (key, value) => `<span><svg><path d="${icons[key]}"></path></svg><span>${value}${key === "criticalChance" ? "%" : ""}</span></span>`;
  window.marketMarkup = () => '<section id="offers">' + [["gun", 20, 220], ["rifle", 60, 280]].map(([code, attack, price]) =>
    `<div class="native-card"><div><img alt="${code}"><div>${stat("attack", attack)}${stat("criticalChance", 10)}</div></div><div class="native-content"><div><a href="/user/000000000000000000000009">Seller</a></div><div class="native-price-row"><div>${price}</div><div><button type="submit">Buy</button></div></div></div></div>`).join("") + '</section>';
  document.getElementById("main-window").innerHTML = marketMarkup();
};
const checks = async function () {
  const check = (value, text) => { if (!value) throw new Error(text); };
  const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  let saved = {}, storageWrites = 0;
  chrome.storage = { local: { async get() { return saved; }, async set(value) { Object.assign(saved, value); storageWrites++; } } };
  testLocation.href = "https://app.warera.io/battle/000000000000000000000001";
  fixturePlayer.skills.hunger = { total: 4, currentBarValue: 0 };
  fixturePlayer.skills.health.currentBarValue = 1;
  document.getElementById("main-window").innerHTML = '<section><div id="header"><span id="defender-round-bar">Defender</span><span id="attacker-round-bar">Attacker</span></div><div style="display:flex;justify-content:space-between"><div><span>+20%</span><button><span>Move</span><span>Lower Juba</span></button></div><div><span>+20%</span><button><span>Move</span><span>Lower Juba</span></button></div></div></section>';
  const perHit = __weAgoPillRoi.create(); perHit.sync(); await flush();
  let average = document.querySelector(".we-ago-pill-roi");
  check(average.querySelectorAll("tr").length === 1 && !average.textContent.includes("1k"), "only average damage remains from per-1k table");
  check(!calls.some(c => c.procedure === "itemOffer.getItemOffers" || c.procedure === "mercenaryContract.getActiveForBattle"), "average damage does not poll rewards or equipment prices");
  const full = __weAgoFullBurst.create(); full.sync(); await flush();
  let panel = document.querySelector(".we-ago-full-burst");
  const cell = metric => panel.querySelector(`[data-metric="${metric}"][data-side="attacker"]`);
  const number = metric => Number(cell(metric).textContent.replace(/[^0-9.]/g,""));
  check(!calls.some(c => c.procedure === "mercenaryContract.getActiveForBattle"), "full burst does not poll the session-only contract endpoint");
  check(cell("contract").textContent.includes("—"), "unobserved contract stays unknown");
  window.__weAgoContracts = { get: () => null }; full.tick();
  check(number("contract") === 0 && !cell("contract").textContent.includes("—"), "native null confirms no contract");
  window.__weAgoContracts = { get: (battleId, muId) => ({ battle: battleId, mu: muId, status: "active", forCountrySide: "attacker", moneyPer1kDamages: 2, minimumDamage: 2000, currentDamages: 1500 }) }; full.tick();
  check(number("contract") === 1, "native contract payout is capped by remaining damage");
  const fishDamage = number("damage"), fishCost = number("cost"), fishBoxes = number("boxes");
  check(fishDamage > 0 && fishCost > 0 && panel.querySelectorAll("tr").length === 7, "compact full-burst damage and financial rows");
  check([...panel.querySelectorAll("tr")].map(row => row.querySelector("td").dataset.metric).join(",") === "damage,bounty,contract,boxes,elite,cost,net", "box market values precede cost and net totals");
  check(cell("boxes").querySelector("svg") && cell("elite").querySelector("svg"), "box rows show money values");
  const signed = metric => Number(cell(metric).textContent.replace(/[^0-9.+−-]/g, "").replace("−", "-"));
  check(number("bounty") === 0, "active contract suppresses the otherwise funded bounty");
  check(Math.abs(signed("net") - (number("contract") + number("boxes") + number("elite") - number("cost"))) < .03, "net uses contract instead of bounty, plus box values minus costs");
  window.__weAgoContracts = { get: () => null }; full.tick();
  check(number("bounty") > 0 && number("contract") === 0, "confirmed no contract restores bounty");
  check(Math.abs(signed("net") - (number("bounty") + number("boxes") + number("elite") - number("cost"))) < .03, "without contract net uses bounty");
  const select = panel.querySelector("select");
  check(select.getAttribute("aria-label") === "Food" && select.options.length === 4, "accessible food selector");
  select.value = "none"; select.dispatchEvent(new Event("change")); await flush();
  check(number("damage") < fishDamage && number("cost") < fishCost, "no food uses only starting HP and removes food cost");
  check(number("boxes") < fishBoxes && number("elite") > 0, "full-burst expected boxes follow food-dependent hit capacity");
  select.value = "bread"; select.dispatchEvent(new Event("change")); await flush();
  check(number("damage") < fishDamage && number("cost") < fishCost, "bread changes burst healing and price");
  check(saved["we-ago:combat-food"] === "bread" && storageWrites === 2, "food selection persisted");
  select.value = "steak"; select.dispatchEvent(new Event("change")); await flush();
  check(number("damage") > fishDamage, "steak healing changes total damage");
  for (let i = 0; i < 3; i++) { perHit.sync(); full.sync(); }
  check(document.querySelectorAll(".we-ago-pill-roi").length === 2, "stable compact panels without duplicates");
  full.destroy(); check(!document.querySelector("select"), "disable removes selector");
  const again = __weAgoFullBurst.create(); again.sync(); await flush();
  panel = document.querySelector(".we-ago-full-burst");
  check(panel.querySelector("select").value === "steak", "saved food restored on re-enable");
  window.denyEquipmentOffers = true; window.denyEquipmentAverage = true; advance(); again.tick(); await flush();
  check(panel.textContent.includes("Net before gear") && !cell("net").textContent.includes("—"), "unavailable equipment keeps labeled subtotal");
  advance(); delaySummary = true; again.tick(); again.destroy();
  summaryResolves.splice(0).forEach(resolve => resolve()); await flush();
  check(!document.querySelector(".we-ago-full-burst"), "late response cannot restore disabled selector");
  perHit.destroy();
  check(document.documentElement.scrollWidth <= innerWidth, "compact layout fits narrow viewport");
  return `PASS ${innerWidth}px food selection, compact rows, persistence, independent reads and cleanup`;
};

try {
  for (const width of [390, 900]) {
    const styles = fs.readFileSync("content/styles.css", "utf8");
    const html = `<!doctype html><meta charset="utf-8"><style>${styles}
      body{margin:0;background:#0a151d;color:#e0e8f0;font:14px system-ui}main{margin:12px}.native-card{display:flex;gap:16px;margin:10px 0;padding:10px}.native-content{width:100%}.native-price-row{display:flex;justify-content:space-between}img{width:48px;height:48px}svg{width:12px;height:12px}#header{display:flex;justify-content:space-between}</style>
      <main id="main-window"></main><script>window.captureUx=${Boolean(process.env.UX_SCREENSHOT_DIR)};(${setup.toString()})();</script>
      <script>${fs.readFileSync("content/ui.js", "utf8")}</script><script>${source.replace('(() => {', '(() => { const location = testLocation;')}</script>
      <script>(${checks.toString()})().then(result=>parent.postMessage(result,'*')).catch(e=>parent.postMessage('FAIL '+e.message,'*'));</script>`;
    fs.writeFileSync(fixture, `<!doctype html><style>body{margin:0}iframe{width:${width}px;height:900px;border:0}</style><iframe></iframe><pre id="result"></pre><script>addEventListener('message',e=>document.getElementById('result').textContent=e.data);document.querySelector('iframe').srcdoc=${JSON.stringify(html).replace(/</g, "\\u003c")};</script>`);
    const result = spawnSync(chrome, ["--headless", "--disable-gpu", "--disable-background-networking", "--no-first-run",
      `--window-size=${width},1000`, `--user-data-dir=${path.join(dir, "profile-" + width)}`,
      "--dump-dom", "--virtual-time-budget=3000",
      ...(process.env.UX_SCREENSHOT_DIR ? [`--screenshot=${path.join(process.env.UX_SCREENSHOT_DIR, `ux-battle-${width}.png`)}`] : []),
      require("node:url").pathToFileURL(fixture).href], { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 2e6 });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    const text = result.stdout.match(/<pre id="result"[^>]*>([^<]*)<\/pre>/)?.[1];
    assert.match(text ?? "No browser result", /^PASS /); console.log(text);
  }
} finally { fs.unlinkSync(fixture); }
