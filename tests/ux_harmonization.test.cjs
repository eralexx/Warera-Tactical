"use strict";

// Actual module renderers with local simulated transport; no game requests/actions.
const assert = require("node:assert/strict"), fs = require("./runtime.cjs"), path = require("node:path");
const os = require("node:os"), { spawnSync } = require("./browser.cjs");
const chrome = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "we-ago-ux-"));
const fixture = path.join(dir, "fixture.html");
const modules = fs.readFileSync("content/ui.js", "utf8") + "\n" + ["company_advisor", "country_builds", "spy_xray", "bounty_radar"].map(name =>
  fs.readFileSync(`content/modules/${name}.js`, "utf8").replace("(() => {", "(() => { const location = testLocation;")).join("\n");
const setup = function () {
  window.testLocation = { pathname: "/companies", href: "https://app.warera.io/companies", origin: "https://app.warera.io" };
  let now = Date.now(); Date.now = () => now;
  window.advance = () => { now += 61000; };
  const playerId = "000000000000000000000001", companyId = "000000000000000000000002";
  const listeners = new Set();
  const data = call => call.procedure === "company.getCompanies"
    ? { items: [{ _id: companyId, user: playerId, name: "Ironworks", itemCode: "steel", activeUpgradeLevels: { automatedEngine: 1 } }] }
    : call.procedure === "gameConfig.getGameConfig"
      ? { items: { steel: { productionPoints: 2 } }, upgradesConfig: { automatedEngine: { levels: { 1: { stats: { dailyProd: 24 } } } } } }
      : call.procedure === "itemTrading.getPrices" ? { steel: 2 }
        : call.procedure === "user.getUserById" ? { _id: playerId, skills: { companies: { value: 1 } } }
          : call.procedure === "company.getProductionBonus" ? { total: 0 } : {};
  const result = call => ({ data: data(call), createdAt: Date.now(), expiresAt: Date.now() + 60000 });
  const stored = {};
  window.chrome = { storage: { local: { async get(key) { return { [key]: stored[key] }; }, async set(values) { Object.assign(stored, values); } } },
    runtime: { id: "fixture", onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
    async sendMessage(message) {
      if (window.holdCompany) await new Promise(resolve => { window.releaseCompany = resolve; });
      if (window.failCompany) return { ok: false, error: { message: "Connection failed" } };
      if (message.type === "WE_AGO_PLAYER_SUMMARY") {
        if (message.includeEquipment !== false) throw Error("Advisor must not request equipment");
        return { ok: true, data: { state: "ready", userId: playerId, profile: { ok: true, result: result({ procedure: "user.getUserById" }) } } };
      }
      if (message.procedure === "user.getUserById") throw Error("Advisor must reuse the summary profile");
      if (message.type === "WE_AGO_BATCH") return { ok: true, data: message.calls.map(result) };
      if (message.type === "WE_AGO_QUERY") return { ok: true, data: result(message) };
      // Keep roster scan pending to test loading fallbacks without API data.
      return new Promise(() => {});
    } } };
};
const checks = async function () {
  const check = (ok, text) => { if (!ok) throw Error(text); };
  const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
  const main = document.querySelector("main"), initial = main.innerHTML;
  const company = __weAgoCompanyAdvisor.create(); company.sync(); await flush();
  const card = document.querySelector(".we-ago-company-card");
  check(card?.parentElement.id === "company", "economics stays inside the native card");
  const originalQuery = document.querySelectorAll;
  let queries = 0;
  document.querySelectorAll = function (...args) { queries++; return originalQuery.apply(this, args); };
  for (let i = 0; i < 60; i++) company.tick();
  document.querySelectorAll = originalQuery;
  check(queries === 0, "60 idle company ticks preserve validated placements without document scans");
  check(card.textContent.includes("24.000") && card.textContent.includes("1.000 /PP") && card.querySelectorAll('svg[aria-label="Gold"]').length === 2, "existing economics values use native gold units");
  check(getComputedStyle(card).backgroundColor === "rgba(0, 0, 0, 0)" && getComputedStyle(card).borderLeftWidth === "0px", "no second card surface or frame");
  check(card.getBoundingClientRect().right <= innerWidth, "company metrics fit viewport");
  const oldMetrics = card.textContent;
  window.holdCompany = true; advance(); company.tick(); await flush();
  check(card.isConnected && card.textContent === oldMetrics, "company metrics survive pending refresh");
  window.holdCompany = false; window.failCompany = true; releaseCompany(); await flush(); company.tick();
  check(card.isConnected && card.textContent === oldMetrics, "company metrics survive failed refresh");
  window.failCompany = false; advance(); company.tick(); await flush();
  company.destroy(); check(main.innerHTML === initial, "native company restored exactly");
  const again = __weAgoCompanyAdvisor.create(); again.sync(); await flush();
  check(document.querySelector(".we-ago-company-card"), "company re-enables without reload");
  main.replaceChildren(); again.sync();
  const companyFallback = document.querySelector(".we-ago-company-fallback");
  check(companyFallback && !companyFallback.open, "unmatched company fallback starts collapsed");
  const host = __weAgoRadarHost.acquire("fixture");
  const nativeDetails = document.querySelector("#native-details"); nativeDetails.open = true;
  companyFallback.open = true; host.root.open = true;
  check(!companyFallback.open && host.root.open && nativeDetails.open, "opening Radar closes only the extension fallback");
  again.destroy(); host.destroy();
  testLocation.pathname = "/country/000000000000000000000003"; testLocation.href = testLocation.origin + testLocation.pathname;
  const builds = __weAgoCountryBuilds.create(), timeline = __weAgoPillTimeline.create();
  builds.sync(); timeline.sync(); await flush();
  const country = document.querySelector(".we-ago-country-fallback");
  check(country && !country.open, "roster fallback starts collapsed");
  // An owned inline chart must not make a closed fallback visible.
  check(country.getBoundingClientRect().height < 50, "closed fallback occupies only its launcher");
  country.open = true;
  const radar = __weAgoRadarHost.acquire("fixture"); radar.root.open = true;
  check(!country.open, "Radar and roster cannot cover each other"); radar.destroy();
  builds.destroy(); timeline.sync(); await flush();
  const graph = document.querySelector(".we-ago-spy-fallback");
  check(graph && !graph.open, "independent timeline fallback starts collapsed");
  graph.open = true;
  const third = __weAgoRadarHost.acquire("fixture"); third.root.open = true;
  check(!graph.open, "independent timeline joins the same disclosure group");
  third.destroy(); timeline.destroy();
  check(!document.querySelector('[data-we-ago="true"]'), "all owned surfaces removed on disable");
  // Leave a real rendered company card for optional visual inspection.
  testLocation.pathname = "/companies"; testLocation.href = testLocation.origin + testLocation.pathname;
  main.innerHTML = initial; const visual = __weAgoCompanyAdvisor.create(); visual.sync(); await flush();
  return `PASS ${innerWidth}px company metrics, native disclosure isolation, fallback defaults, independent re-enable and cleanup`;
};
try {
  for (const width of [390, 900]) {
    const html = `<!doctype html><meta charset="utf-8"><style>${fs.readFileSync("content/styles.css", "utf8")}
      body{margin:0;background:#071815;color:#b7d0ca;font:14px system-ui}main{margin:16px}article{max-width:440px;padding:15px;background:#0c201e;border:1px solid #274744;border-radius:4px}h2{margin:0 0 8px}p{margin:8px 0}</style>
      <main><article id="company" data-company-id="000000000000000000000002"><h2>Ironworks</h2><p>Steel · Automated engine 1</p></article></main>
      <details id="native-details"><summary>Native section</summary>Native content</details>
      <script>(${setup.toString()})();</script><script>${modules}</script>
      <script>(${checks.toString()})().then(t=>parent.postMessage(t,'*')).catch(e=>parent.postMessage('FAIL '+e.stack,'*'));</script>`;
    fs.writeFileSync(fixture, `<!doctype html><style>body{margin:0}iframe{width:${width}px;height:800px;border:0}</style><iframe></iframe><pre id="result"></pre><script>addEventListener('message',e=>document.getElementById('result').textContent=e.data);document.querySelector('iframe').srcdoc=${JSON.stringify(html).replace(/</g, "\\u003c")};</script>`);
    const screenshots = process.env.UX_SCREENSHOT_DIR;
    const run = spawnSync(chrome, ["--headless", "--disable-gpu", "--disable-background-networking", "--no-first-run",
      `--user-data-dir=${path.join(dir, "profile-" + width)}`, `--window-size=${width},900`, "--virtual-time-budget=3000", "--dump-dom",
      ...(screenshots ? [`--screenshot=${path.join(screenshots, `ux-company-${width}.png`)}`] : []),
      require("node:url").pathToFileURL(fixture).href], { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 2e6 });
    assert.equal(run.status, 0, run.error?.message || run.stderr);
    const result = run.stdout.match(/<pre id="result"[^>]*>([^<]*)<\/pre>/)?.[1];
    assert.match(result ?? "No browser result", /^PASS /); console.log(result);
  }
} finally { fs.unlinkSync(fixture); }
