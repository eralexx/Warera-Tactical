"use strict";

// Real Chrome layout/lifecycle regression; no credentials or game requests.
const assert = require("node:assert/strict");
const fs = require("./runtime.cjs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("./browser.cjs");
const chrome = [process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find(file => file && fs.existsSync(file));
assert.ok(chrome, "Set CHROME_PATH to a Chrome executable to run this browser regression.");
const root = path.join(__dirname, "..");
const styles = fs.readFileSync(path.join(root, "content/styles.css"), "utf8");
const moduleCode = fs.readFileSync(path.join(root, "content/modules/country_builds.js"), "utf8");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "we-ago-country-"));
const fixture = path.join(dir, "fixture.html");
const checks = async function () {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const owned = () => document.querySelector(".we-ago-country-builds-card");
  const shell = document.querySelector("#__next");
  const initial = shell.outerHTML;
  let instance = __weAgoCountryBuilds.create();
  instance.sync(); await settle();
  check(owned()?.isConnected, "loading/error card is visible without content anchors");
  check(document.querySelector(".we-ago-country-fallback").parentElement === document.body, "fallback outside app shell");
  const fallback = document.querySelector(".we-ago-country-fallback");
  check(!fallback.open, "fallback does not obscure the game during loading");
  fallback.open = true;
  check(shell.outerHTML === initial, "native banner and shell remain unchanged");
  check(owned().textContent.includes("Scanning citizens"), "scan progress visible");
  const first = requests[0];
  progress({ type: "WE_AGO_COUNTRY_SCAN_PROGRESS", countryId: "a", requestId: first.message.requestId, scanned: 20, total: 100 }, { id: "fixture" });
  check(owned().textContent.includes("20/100"), "matching progress rendered");

  const content = document.createElement("div");
  content.className = "content";
  content.innerHTML = '<section id="rankings"><h2>Rankings →</h2><div class="tiles">Native rank cards</div></section><section id="government"><h2>Government →</h2><p>Native government</p></section>';
  shell.append(content);
  const native = [...content.children];
  instance.sync();
  check(owned().parentElement === content && owned().nextElementSibling === native[0], "card before rankings, outside banner");
  check(!document.querySelector(".we-ago-country-fallback"), "fallback removed on inline migration");
  const banner = document.querySelector(".banner");
  check(banner.clientHeight === 150 && banner.children.length === 1, "clipped banner unaffected");
  first.resolve({ ok: true, data: snapshot("a") }); await settle();
  check(owned().textContent.includes("Median level 20"), "response renders");
  const originalQuery = document.querySelectorAll;
  let queries = 0;
  document.querySelectorAll = function (...args) { queries++; return originalQuery.apply(this, args); };
  for (let i = 0; i < 60; i++) instance.tick();
  document.querySelectorAll = originalQuery;
  check(queries === 0, "60 idle census ticks update age without placement scans");
  check(owned().querySelectorAll(".we-ago-country-pill").length === 3, "three build totals");
  const rect = owned().getBoundingClientRect();
  check(rect.left >= 0 && rect.right <= innerWidth, "card fits narrow viewport");
  check(document.documentElement.scrollWidth <= innerWidth, "no horizontal page overflow");
  check(owned().querySelectorAll('*:not([data-we-ago="true"])').length === 0, "every injected descendant owned");
  const buttons = owned().querySelectorAll(".we-ago-country-button");
  buttons[1].click();
  check(owned().textContent.includes("1 citizens"), "veteran filter local");
  check(requests.length === 1, "filter does not request new scan");
  const drawer = owned().querySelector("details"); drawer.open = true; drawer.dispatchEvent(new Event("toggle"));
  check(owned().querySelectorAll("tbody tr").length === 1, "drawer rows render");

  content.style.display = "flex"; content.style.flexDirection = "row";
  instance.sync();
  check(owned().closest(".we-ago-country-fallback"), "horizontal flex rejected");
  check(owned().closest(".we-ago-country-fallback").open, "user expansion survives inline migration and anchor loss");
  content.style.flexDirection = "column"; instance.sync();
  check(owned().parentElement === content, "vertical flex accepted");
  content.style.display = "grid"; content.style.gridTemplateColumns = "1fr 1fr"; instance.sync();
  check(owned().closest(".we-ago-country-fallback"), "multi-column grid rejected");
  content.style.display = "block"; instance.sync();
  owned().remove(); instance.sync();
  check(owned()?.isConnected, "detached card restored");
  check(native.every(node => node.parentElement === content), "native sections preserved");

  testLocation.pathname = "/country/b"; instance.sync();
  const second = requests[1];
  testLocation.pathname = "/country/a"; instance.sync();
  second.resolve({ ok: true, data: snapshot("b") }); await settle();
  check(!owned().textContent.includes("Median level"), "late other-country response ignored");
  const last = requests[2];
  instance.destroy();
  last.resolve({ ok: true, data: snapshot("a") }); await settle();
  check(!owned() && listeners.size === 0, "disable removes UI and progress listener; late response ignored");
  instance = __weAgoCountryBuilds.create(); instance.sync();
  requests[3].resolve({ ok: false, error: { message: "Save API token in the popup" } }); await settle();
  check(owned().textContent.includes("Save API token"), "reenable displays actionable error");
  check(owned().querySelector(".we-ago-country-bar").hidden && owned().querySelector("details").hidden, "no empty chart or drawer on error");
  check(!owned().querySelectorAll(".we-ago-country-button")[2].disabled, "failed scan offers retry");
  owned().querySelectorAll(".we-ago-country-button")[2].click();
  const recovered = snapshot("a"); recovered.createdAt -= 61000;
  requests[4].resolve({ ok: true, data: recovered }); await settle();
  testNow += 61001; instance.sync();
  owned().querySelectorAll(".we-ago-country-button")[2].click();
  requests[5].resolve({ ok: false, error: { message: "Temporary connection failure" } }); await settle();
  const retry = owned().querySelectorAll(".we-ago-country-button")[2];
  check(retry.textContent === "Retry" && !retry.disabled, "failed forced refresh bypasses 60-second lockout");
  retry.click();
  check(requests[6].message.forceRefresh === true, "retry bypasses underlying read caches");
  requests[6].resolve({ ok: true, data: snapshot("a") }); await settle();
  check(owned().textContent.includes("Median level 20"), "retry recovers current country");
  testLocation.pathname = "/country/b"; instance.sync();
  const nextCountry = snapshot("b"); nextCountry.all.medianLevel = 30; nextCountry.veterans.medianLevel = 30;
  requests[7].resolve({ ok: true, data: nextCountry }); await settle();
  check(owned().textContent.includes("Median level 30"), "next country renders its own successful result");
  check(owned().querySelectorAll(".we-ago-country-builds-card").length === 0, "no nested duplicates");
  testLocation.pathname = "/companies"; instance.sync();
  check(!owned() && !document.querySelector(".we-ago-country-fallback"), "route exit cleanup");
  instance.destroy();
  // Leave a populated card for optional visual inspection of the same fixture.
  testLocation.pathname = "/country/a";
  instance = __weAgoCountryBuilds.create(); instance.sync();
  requests[8].resolve({ ok: false, error: { code: "SCAN_CANCELLED", message: "Scan superseded" } }); await settle();
  instance.tick();
  check(requests.length === 10, "enabled census resumes an interrupted scan automatically");
  requests[9].resolve({ ok: true, data: snapshot("a") }); await settle();
  testNow += 900001; instance.tick();
  check(requests.length === 11, "expired census starts automatic refresh");
  check(owned().textContent.includes("Median level 20"), "census remains visible during refresh");
  requests[10].resolve({ ok: false, error: { message: "Offline" } }); await settle();
  check(owned().textContent.includes("Median level 20"), "census survives a failed refresh");
  testNow += 30001; instance.tick();
  check(requests.length === 12, "failed census refresh retries after backoff");
  const replacement = snapshot("a"); replacement.all.medianLevel = 30;
  requests[11].resolve({ ok: true, data: replacement }); await settle();
  check(owned().textContent.includes("Median level 30"), "successful census replaces last known values");

  document.getElementById("result").textContent = "PASS country layout, progress, filtering, lifecycle and stale responses; viewport " + innerWidth;
  parent.postMessage({ countryResult: document.getElementById("result").textContent }, "*");
};
try {
  const html = `<!doctype html><meta charset="utf-8"><style>
    body { margin:0; background:#071615; } #__next { display:flex; flex-direction:column; }
    .banner { display:flex; height:150px; overflow:hidden; } .banner h1 { width:100%; }
    .content { margin:15px; } h2 { color:white; } ${styles}
    </style><div id="__next"><div class="banner"><h1>Country Spain</h1></div></div><pre id="result" hidden></pre><script>
    const testLocation = { pathname: '/country/a' };
    let testNow = Date.now(); Date.now = () => testNow;
    const requests = [], listeners = new Set();
    const progress = (...args) => { for (const listener of listeners) listener(...args); };
    const chrome = {runtime:{id:'fixture', sendMessage(message) { if(message.type==='WE_AGO_CENSUS_UNSUBSCRIBE')return Promise.resolve({ok:true,data:{removed:1}}); return new Promise(resolve => requests.push({message,resolve})); },
      onMessage:{addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn)}}};
    function snapshot(countryId) {
      const summary = {eco:1,damage:1,hybrid:0,ecoPct:50,damagePct:50,hybridPct:0,total:2,classified:2,unknown:0,unallocated:0,medianLevel:20};
      return {countryId,createdAt:Date.now(),expiresAt:Date.now()+900000,all:summary,veterans:{...summary,total:1},
        citizens:[{id:'x',username:'Citizen',level:25,build:'eco',combatShare:0.2},{id:'y',username:'Other',level:10,build:'damage',combatShare:0.8}]};
    }
    ${moduleCode.replace(/location\.pathname/g, "testLocation.pathname")}
    (${checks.toString()})().catch(error => parent.postMessage({countryResult:'FAIL '+error.stack}, '*'));
    </script>`;
  for (const width of [529, 390]) {
    // Chrome's native window has a minimum width; an iframe gives an exact viewport.
    fs.writeFileSync(fixture, `<!doctype html><style>body{margin:0}iframe{border:0;width:${width}px;height:850px}</style>
      <iframe></iframe><pre id="result" hidden></pre><script>
      addEventListener('message', event => { if(event.source === document.querySelector('iframe').contentWindow)
        document.getElementById('result').textContent = event.data.countryResult; });
      document.querySelector('iframe').srcdoc = ${JSON.stringify(html).replace(/</g, "\\u003c")};</script>`);
    const screenshot = process.env.COUNTRY_BUILDS_SCREENSHOT_DIR;
    const run = spawnSync(chrome, ["--headless", "--disable-gpu", "--no-first-run", `--window-size=${width},850`,
      `--user-data-dir=${path.join(dir, "profile")}`,
      ...(screenshot ? [`--screenshot=${path.join(screenshot, `country-builds-${width}.png`)}`] : []),
      "--dump-dom", "--virtual-time-budget=2000", require("node:url").pathToFileURL(fixture).href], { encoding: "utf8", timeout: 30000, maxBuffer: 2e6 });
    assert.equal(run.status, 0, run.error?.message || run.stderr);
    const result = run.stdout.match(/<pre id="result"[^>]*>([^<]*)<\/pre>/)?.[1];
    assert.match(result || "No browser result", /^PASS /);
    assert.ok(result.endsWith(`viewport ${width}`), result);
    console.log(`${width}px: ${result}`);
  }
} finally {
  fs.unlinkSync(fixture);
  // Chrome owns its temporary profile; leave it to OS temp cleanup.
  if (!fs.existsSync(path.join(dir, "profile"))) fs.rmdirSync(dir);
}
