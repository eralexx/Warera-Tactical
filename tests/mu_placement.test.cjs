"use strict";

// The user's supplied MU DOM, including header stats, div/span headings,
// single-child section wrappers, ranked UL, and Recent Applications.
const assert = require("node:assert/strict"), fs = require("./runtime.cjs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("./browser.cjs");
const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find(file => file && fs.existsSync(file));
assert(chrome, "Set CHROME_PATH for the local Chrome regression");
const root = path.join(__dirname, ".."), dir = fs.mkdtempSync(path.join(os.tmpdir(), "we-ago-mu-dom-"));
const fixture = path.join(dir, "fixture.html");
const input = fs.readFileSync(path.join(__dirname, "fixtures/mu-home-6a7d0f2a.html"), "utf8");
const css = fs.readFileSync(path.join(root, "content/styles.css"), "utf8");
const census = fs.readFileSync(path.join(root, "content/modules/country_builds.js"), "utf8");
const spy = fs.readFileSync(path.join(root, "content/modules/spy_xray.js"), "utf8");
const checks = async function () {
  const check = (ok, text) => { if (!ok) throw new Error(text); };
  const OWNED = '[data-we-ago="true"]', muId = "6a7d0f2ada40995d86eeb0de";
  // Remove the previous extension render copied into the attachment. Reloading
  // the real game similarly starts with native markup. Never execute snapshot code.
  for (const node of document.querySelectorAll("script, iframe, object, embed, link, base")) if (node.closest("#snapshot-host")) node.remove();
  for (const node of document.querySelectorAll("#snapshot-host *")) for (const attribute of [...node.attributes]) if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
  for (const node of document.querySelectorAll(OWNED)) node.remove();
  const main = document.getElementById("main-window"), banner = main.children[0], column = main.children[1];
  const battleOrders = column.children[0], memberBlock = column.children[6], inner = memberBlock.firstElementChild, list = memberBlock.querySelector("ul");
  check(battleOrders.textContent.includes("Battle orders"), "supplied first native section is Battle orders");
  check(list && memberBlock.textContent.includes("Members"), "original ranked Members block");
  // Stress the placement contract: the native controls/list panel is not a
  // safe vertical insertion point. The outer content column is.
  inner.style.display = "flex"; inner.style.flexDirection = "row"; inner.style.overflow = "hidden";
  const initial = main.outerHTML, memberHTML = memberBlock.outerHTML, bannerHTML = banner.outerHTML;
  const ids = [...new Set([...list.querySelectorAll('a[href*="/user/"]')].map(a => a.getAttribute("href").split("/").pop()))];
  check(ids.length === 16, "all 16 supplied MU members retained");
  let now = Date.UTC(2026, 9, 21, 10);
  Date.now = () => now;
  const config = { items: { cocain: { flatStats: { percentAttack: 60, debuffDurationHours: 15.5 } } } };
  const profiles = ids.map((id, n) => ({ _id: id, username: "Member " + n,
    buffs: n % 2 ? { buffCodes: ["cocain"], buffEndAt: new Date(now + 3600000).toISOString() } : null,
    skills: { attack: { level: n % 3 ? 10 : 1 }, production: { level: n % 3 === 1 ? 0 : 10 } } }));
  const counts = { total: 16, classified: 16, medianLevel: 33, eco: 6, damage: 5, hybrid: 5, unknown: 0, unallocated: 0,
    ecoPct: 37.5, damagePct: 31.25, hybridPct: 31.25 };
  const listeners = new Set();
  window.chrome = { runtime: { id: "fixture", onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) }, async sendMessage(message) {
    if (message.type === "WE_AGO_GET_MU_BUILDS") return { ok: true, data: { scope: "mu", countryId: muId, createdAt: now, expiresAt: now + 900000,
      all: counts, veterans: counts, citizens: profiles.map((p, n) => ({ id: p._id, username: p.username, level: 33,
        build: n % 3 === 0 ? "eco" : n % 3 === 1 ? "damage" : "hybrid", combatShare: n % 3 === 0 ? .1 : n % 3 === 1 ? 1 : .5 })) } };
    return { ok: true, data: message.calls.map(call => ({ createdAt: now, expiresAt: now + call.ttlSeconds * 1000,
      data: call.procedure === "gameConfig.getGameConfig" ? config : call.procedure === "mu.getById" ? { _id: muId, members: ids }
        : profiles.find(p => p._id === call.input.userId) })) };
  } } };
  const graph = __weAgoPillTimeline.create(); let builds = __weAgoCountryBuilds.create();
  const tick = async () => { now += 1200; builds.sync(); graph.sync(); for (let i = 0; i < 10; i++) await Promise.resolve(); };
  for (let i = 0; i < 5; i++) await tick();
  let card = document.querySelector(".we-ago-country-builds-card"), chart = document.querySelector(".we-ago-spy-timeline");
  check(card?.parentElement === column && column.firstElementChild === card && card.nextElementSibling === battleOrders, "summary at top ahead of Battle orders");
  check(chart?.parentElement === card && chart.previousElementSibling.classList.contains("we-ago-country-drawer"), "graph below extension Members drawer");
  check(!card.querySelector("details").open && chart.getBoundingClientRect().height > 100, "graph visible with Members collapsed");
  check(!document.querySelector(".we-ago-country-fallback, .we-ago-spy-fallback"), "neither feature floats over the page");
  check(!memberBlock.querySelector(OWNED) && memberBlock.outerHTML === memberHTML, "native header, controls and ranked roster untouched");
  check(banner.outerHTML === bannerHTML, "header Members statistic never selected");
  check(card.getBoundingClientRect().width <= column.clientWidth, "card respects content width");
  check(chart.querySelectorAll(".we-ago-spy-line").length === 2 && !chart.textContent.includes("Ready"), "only filtered buff/debuff series");
  builds.destroy(); graph.sync();
  check(chart.parentElement === column && column.firstElementChild === chart && chart.nextElementSibling === battleOrders, "timeline alone stays ahead of Battle orders");
  check(!document.querySelector(".we-ago-spy-fallback"), "timeline remains inline with census disabled");
  builds = __weAgoCountryBuilds.create(); for (let i = 0; i < 3; i++) await tick();
  card = document.querySelector(".we-ago-country-builds-card");
  check(chart.parentElement === card && card.parentElement === column, "reenable migrates same graph into summary");
  const replacement = memberBlock.cloneNode(true); memberBlock.replaceWith(replacement);
  card.remove(); for (let i = 0; i < 3; i++) await tick();
  check(card.parentElement === column && column.firstElementChild === card && card.nextElementSibling === battleOrders, "SPA replacement/removal keeps top placement");
  check(document.querySelectorAll(".we-ago-country-builds-card").length === 1 && document.querySelectorAll(".we-ago-spy-timeline").length === 1, "no duplicates");
  testLocation.pathname = "/companies"; testLocation.href = testLocation.origin + testLocation.pathname;
  builds.sync(); graph.sync(); builds.destroy(); graph.destroy();
  check(!document.querySelector(OWNED) && main.outerHTML === initial, "route exit restores exact native markup");
  check(listeners.size === 0, "progress listeners removed");
  return `PASS supplied MU DOM ${innerWidth}px: section attachment, independent graph, native preservation, SPA cleanup`;
};
try {
  for (const width of [390, 900]) {
    const page = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
      <style>${css}body{margin:0;background:#071615;color:#dcebe5;font:12px system-ui}*{box-sizing:border-box}
      #main-window-container{width:100%;max-width:850px;margin:auto}#main-window{height:auto!important;padding:0!important}
      #main-window>div:first-child{height:160px;overflow:hidden;position:relative}#main-window>div:nth-child(2){display:flex;flex-direction:column;gap:16px;padding:12px}
      #main-window>div:nth-child(2)>div{min-width:0}img{max-width:32px;max-height:32px}svg:not(.we-ago-spy-chart){width:16px;height:16px}a{color:#9bd4d0}</style>
      <div id="snapshot-host">${input}</div><script>const testLocation={origin:"https://app.warera.io",pathname:"/mu/6a7d0f2ada40995d86eeb0de",href:"https://app.warera.io/mu/6a7d0f2ada40995d86eeb0de"};</script>
      <script>${census.replace('(() => {', '(() => { const location = testLocation;')}</script>
      <script>${spy.replace('(() => {', '(() => { const location = testLocation;')}</script>
      <script>(${checks.toString()})().then(result=>parent.postMessage({muResult:result},'*')).catch(e=>parent.postMessage({muResult:'FAIL '+e.message},'*'));</script>`;
    fs.writeFileSync(fixture, `<!doctype html><style>body{margin:0;overflow:hidden}iframe{border:0;width:${width}px;height:1000px}</style><iframe></iframe><pre id="result" hidden></pre><script>
      addEventListener('message',e=>{if(e.source===document.querySelector('iframe').contentWindow)document.getElementById('result').textContent=e.data.muResult;});
      document.querySelector('iframe').srcdoc=${JSON.stringify(page).replace(/</g, "\\u003c")};</script>`);
    const result = spawnSync(chrome, ["--headless", "--disable-gpu", "--no-first-run", "--disable-background-networking",
      `--window-size=${width},1000`, `--user-data-dir=${path.join(dir, "profile-" + width)}`,
      "--dump-dom", "--virtual-time-budget=3000", require("node:url").pathToFileURL(fixture).href], { encoding: "utf8", timeout: 30000, maxBuffer: 4e6 });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    const text = result.stdout.match(/<pre id="result"[^>]*>([^<]*)<\/pre>/)?.[1];
    assert.match(text || "No browser result", /^PASS /); console.log(text);
  }
} finally { fs.unlinkSync(fixture); }
