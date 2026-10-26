"use strict";

// Combined census/readiness/timeline regression, not an isolated ideal table.
// Real Chrome, mock transport, no credentials or live game actions.
const assert = require("node:assert/strict"), fs = require("./runtime.cjs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("./browser.cjs");
const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find(file => file && fs.existsSync(file));
assert(chrome, "Set CHROME_PATH to run the local Chrome regression");
const root = path.join(__dirname, ".."), dir = fs.mkdtempSync(path.join(os.tmpdir(), "we-ago-spy-"));
const fixture = path.join(dir, "fixture.html");
const styles = fs.readFileSync(path.join(root, "content/styles.css"), "utf8");
const spy = fs.readFileSync(path.join(root, "content/modules/spy_xray.js"), "utf8");
const census = fs.readFileSync(path.join(root, "content/modules/country_builds.js"), "utf8");
const setup = function () {
  const id = n => n.toString(16).padStart(24, "0");
  let now = Date.UTC(2026, 9, 21, 10), requests = 0;
  Date.now = () => now;
  window.spyClock = () => { now += 1200; };
  const config = { items: { cocain: { flatStats: { percentAttack: 60, debuffDurationHours: 15.5 } },
    heavyAmmo: { flatStats: { percentAttack: 40 } }, cookedFish: { flatStats: { healthRegenPercent: 20 } } },
    battle: { healthCost: 10 }, skills: { precision: { skillOverflowValue: 4 }, criticalChance: { skillOverflowValue: 4 }, armor: { softCap: 40 }, dodge: { softCap: 40 } } };
  const profile = userId => ({ _id: userId, buffs: userId === id(1)
    ? { buffCodes: ["cocain"], buffEndAt: new Date(now + 2 * 3600000).toISOString() }
    : userId === id(2) ? { debuffCodes: ["cocain"], debuffEndAt: new Date(now + 4 * 3600000).toISOString() } : null,
    skills: Object.fromEntries(Object.entries({ health: { value: 100, total: userId === id(1) ? 150 : 100, currentBarValue: userId === id(1) ? 2.5 : 75 },
      hunger: { value: 4, total: 8, currentBarValue: .8 }, attack: { value: 100, level: userId === id(1) ? 1 : userId === id(2) ? 8 : 5, militaryRankPercent: 0 },
      production: { value: 0, level: userId === id(1) ? 10 : userId === id(2) ? 0 : 5 },
      precision: { value: 80 }, criticalChance: { value: 25 }, criticalDamages: { value: 150 }, armor: { value: 40 }, dodge: { value: 25 } }).map(([k, v]) => [k, { level: 0, ...v }])) });
  window.chrome = { runtime: { id: "fixture", onMessage: { addListener() {}, removeListener() {} }, async sendMessage(message) {
    requests++;
    if (/^WE_AGO_GET_(?:COUNTRY|MU)_BUILDS$/.test(message.type)) {
      const counts = { total: 3, classified: 3, medianLevel: 42, eco: 1, damage: 1, hybrid: 1, unknown: 0, unallocated: 0, ecoPct: 33.33, damagePct: 33.33, hybridPct: 33.33 };
      return { ok: true, data: { countryId: id(50), scope: testLocation.pathname.split("/")[1], createdAt: now, expiresAt: now + 900000,
        all: counts, veterans: counts, citizens: [1, 2, 3].map((n, i) => ({ id: id(n), username: ["Atlas", "Frontline", "Ready player"][i], level: 42,
          build: ["eco", "damage", "hybrid"][i], combatShare: [.2, .8, .5][i] })) } };
    }
    return { ok: true, data: message.calls.map(call => ({ createdAt: now, expiresAt: now + call.ttlSeconds * 1000,
      data: call.procedure === "gameConfig.getGameConfig" ? config
        : call.procedure === "inventory.fetchCurrentEquipment" ? { ammo: "heavyAmmo", weapon: { skills: { attack: 100 } } }
        : call.procedure === "mu.getById" ? { _id: id(50), members: [id(1), id(2), id(3)] }
        : call.procedure === "user.getUsersByCountry" ? { items: [1, 2, 3].map(n => ({ _id: id(n) })) }
        : profile(call.input.userId) })) };
  } } };
  window.spyRequests = () => requests;
};
const checks = async function () {
  const check = (v, text) => { if (!v) throw Error(text); };
  const native = document.querySelector("main"), before = native.outerHTML, originalHTML = native.innerHTML;
  const originalPath = testLocation.pathname, originalHref = testLocation.href;
  const builds = __weAgoCountryBuilds.create(), rows = __weAgoSpyXray.create(), graph = __weAgoPillTimeline.create();
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const tick = async () => { spyClock(); builds.sync(); rows.sync(); graph.sync(); await flush(); };
  for (let i = 0; i < 5; i++) await tick();
  const card = document.querySelector(".we-ago-country-builds-card"), drawer = card.querySelector(".we-ago-country-drawer");
  const chart = document.querySelector(".we-ago-spy-timeline");
  check(card.querySelectorAll(".we-ago-country-pill").length === 3, "build summary on both Country and MU");
  check(chart && chart.previousElementSibling === drawer && chart.parentElement === card, "graph directly below Citizens/Members");
  check(!drawer.open && chart.getBoundingClientRect().height > 100, "graph visible while Citizens/Members closed");
  check(!document.querySelector(".we-ago-spy-fallback"), "no floating graph when census exists");
  check(!document.querySelector(".we-ago-spy-strip"), "no readouts scattered in other lists/chat while drawer is closed");
  check(document.querySelector(".we-ago-spy-coverage").textContent === "2/2 Damage/Hybrid", "only combat/hybrid roster coverage");
  drawer.open = true; drawer.dispatchEvent(new Event("toggle"));
  for (let i = 0; i < 5; i++) await tick();
  const strips = [...document.querySelectorAll(".we-ago-spy-strip")];
  check(strips.length === 3 && strips.every(n => n.closest(".we-ago-country-table")), "one canonical readout per citizen/member");
  check(!document.querySelector("#chat .we-ago-spy-strip"), "chat untouched");
  check(!document.querySelector("#native-members .we-ago-spy-strip"), "duplicate native links untouched");
  const bars = strips[0].querySelectorAll('[role="progressbar"]');
  check(bars.length === 2, "two visual resource bars");
  check(bars[0].getAttribute("aria-valuenow") === "2.5" && bars[0].getAttribute("aria-valuemax") === "150", "actual HP amount and capacity");
  check(Math.abs(parseFloat(bars[0].firstElementChild.style.width) - 2.5 / 150 * 100) < .001, "HP fill proportional, not just a numeric badge");
  check(parseFloat(bars[1].firstElementChild.style.width) === 10, "hunger fill proportional");
  check(bars[0].getBoundingClientRect().height >= 18 && bars[0].getBoundingClientRect().width > 80, "bars have visible area");
  check(!strips[0].querySelector('[data-state="buff"]') && strips[1].textContent.includes("Debuff "), "Eco timer excluded; Damage timer retained");
  check(!strips[2].querySelector('[data-state="ready"]'), "no Ready row label");
  drawer.dispatchEvent(new Event("toggle"));
  check(strips.every(n => n.isConnected), "repeated disclosure event preserves resource bars");
  check(chart.querySelectorAll("path.we-ago-spy-line").length === 2, "only buff/debuff series");
  check(!chart.querySelector('[data-state="ready"]') && !chart.textContent.includes("Ready"), "no Ready legend/readout/line");
  check(chart.querySelector('.we-ago-spy-readout').textContent.includes("Buffed 0"), "active Eco buff excluded from counts");
  check(document.documentElement.scrollWidth <= innerWidth, "no horizontal page overflow");
  check(chart.getBoundingClientRect().width <= innerWidth, "responsive chart");
  check([...document.querySelectorAll('[data-we-ago="true"]')].every(n => n.classList.length && [...n.classList].every(c => c.startsWith("we-ago-"))), "every created node owned");
  rows.destroy(); check(!document.querySelector(".we-ago-spy-strip") && document.querySelector(".we-ago-spy-timeline"), "independent readiness toggle");
  graph.destroy(); builds.destroy(); check(native.outerHTML === before, "native DOM restored exactly");
  const last = spyRequests(); rows.sync(); graph.sync(); builds.sync(); await flush(); check(last === spyRequests(), "no polling after disable");
  testLocation.pathname = "/battle/000000000000000000000032"; testLocation.href = testLocation.origin + testLocation.pathname;
  native.innerHTML = '<section><h2>Fighters</h2><table><tbody>' + [1, 1, 2, 3].map(n => '<tr><td><a href="/user/' + String(n).padStart(24, '0') + '">Fighter ' + n + '</a></td></tr>').join('')
    + '</tbody></table></section><div id="chat"><a href="/user/000000000000000000000001">Fighter 1 in chat</a><a href="/user/000000000000000000000004">Chat only</a></div>';
  const battleMarkup = native.outerHTML, battleRows = __weAgoSpyXray.create();
  for (let i = 0; i < 5; i++) { spyClock(); battleRows.sync(); await flush(); }
  check(document.querySelectorAll(".we-ago-spy-strip").length === 3, "battle IDs are deduplicated");
  check(!document.querySelector("#chat .we-ago-spy-strip"), "battle chat names never receive readouts");
  battleRows.destroy(); check(native.outerHTML === battleMarkup, "battle native markup restored");
  testLocation.pathname = originalPath; testLocation.href = originalHref; native.innerHTML = originalHTML;
  const b = __weAgoCountryBuilds.create(), a = __weAgoSpyXray.create(), c = __weAgoPillTimeline.create();
  for (let i = 0; i < 5; i++) { spyClock(); b.sync(); a.sync(); c.sync(); await flush(); }
  const d = document.querySelector(".we-ago-country-drawer"); d.open = true; d.dispatchEvent(new Event("toggle"));
  for (let i = 0; i < 5; i++) { spyClock(); b.sync(); a.sync(); c.sync(); await flush(); }
  return `PASS ${testLocation.pathname.split('/')[1]} ${innerWidth}px visual bars, canonical rows, census+graph placement and cleanup`;
};
try {
  for (const kind of ["country", "mu"]) for (const width of [390, 900]) {
    const href = `https://app.warera.io/${kind}/000000000000000000000032`;
    const locationCode = `const location = testLocation;`;
    const html = `<!doctype html><meta charset="utf-8"><style>${styles}
      body{margin:0;background:#0a151d;color:#e0e8f0;font:14px system-ui}main{margin:12px}h2{font-size:17px}
      table{width:100%;border-collapse:collapse}td{padding:8px 4px;border-bottom:1px solid #29404b}a{color:#a5d2ff}
      </style><main>${kind === "country" ? '<section><h2>Rankings →</h2><div>Native rankings</div></section><section><h2>Government →</h2></section>'
      : '<section><h2>Members</h2><table id="native-members"><tbody><tr><td><a href="/user/000000000000000000000001">Atlas</a></td></tr><tr><td><a href="/user/000000000000000000000001">Atlas again</a></td></tr></tbody></table></section>'}
      <div id="chat"><a href="/user/000000000000000000000001">Atlas</a><p>A chat message</p><a href="/user/000000000000000000000002">Frontline</a></div></main>
      <script>const testLocation = {href:${JSON.stringify(href)},origin:"https://app.warera.io",pathname:${JSON.stringify(new URL(href).pathname)}};(${setup.toString()})();</script>
      <script>${census.replace('(() => {', '(() => {' + locationCode)}</script><script>${spy.replace('(() => {', '(() => {' + locationCode)}</script>
      <script>(${checks.toString()})().then(result=>parent.postMessage({spyResult:result},'*')).catch(error=>parent.postMessage({spyResult:'FAIL '+error.message},'*'));</script>`;
    fs.writeFileSync(fixture, `<!doctype html><style>body{margin:0;overflow:hidden}iframe{border:0;width:${width}px;height:1100px}</style><iframe></iframe><pre id="result" hidden></pre><script>
      addEventListener('message',e=>{if(e.source===document.querySelector('iframe').contentWindow)document.getElementById('result').textContent=e.data.spyResult;});
      document.querySelector('iframe').srcdoc=${JSON.stringify(html).replace(/</g, "\\u003c")};</script>`);
    const screenshot = process.env.SPY_XRAY_SCREENSHOT_DIR;
    const result = spawnSync(chrome, ["--headless", "--disable-gpu", "--disable-background-networking", "--no-first-run",
      `--window-size=${width},1100`, `--user-data-dir=${path.join(dir, "profile-" + kind + width)}`,
      ...(screenshot ? [`--screenshot=${path.join(screenshot, `spy-${kind}-${width}.png`)}`] : []),
      "--dump-dom", "--virtual-time-budget=3000", require("node:url").pathToFileURL(fixture).href], { encoding: "utf8", timeout: 30000, maxBuffer: 2e6 });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    const text = result.stdout.match(/<pre id="result"[^>]*>([^<]*)<\/pre>/)?.[1];
    assert.match(text ?? "No browser result", /^PASS /); console.log(text);
  }
} finally { fs.unlinkSync(fixture); }
