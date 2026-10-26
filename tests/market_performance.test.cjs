"use strict";
const assert = require("node:assert/strict"), fs = require("./runtime.cjs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("./browser.cjs");
const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find(file => file && fs.existsSync(file));
assert(chrome, "Chrome is required for the market performance fixture");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "we-ago-market-perf-")), fixture = path.join(dir, "fixture.html");
const setup = function () {
  window.testLocation = { href: "https://app.warera.io/market", pathname: "/market" };
  let now = Date.now(); Date.now = () => now;
  window.advance = () => { now += 121000; };
  window.calls = [];
  window.chrome = { runtime: { id: "fixture", onMessage: { addListener() {}, removeListener() {} }, async sendMessage(message) {
    calls.push(message);
    if (message.type === "WE_AGO_DISPLAY_GET") return { ok: true, data: { marketFontSize: 14 } };
    if (window.holdMarket) await new Promise(resolve => { window.releaseMarket = resolve; });
    if (window.failMarket) return { ok: false };
    const result = data => ({ data, createdAt: now, expiresAt: now + 120000 });
    if (message.type === "WE_AGO_QUERY") return { ok: true, data: result({ steel: 100, concrete: 200 }) };
    if (message.type === "WE_AGO_BATCH") return { ok: true, data: message.calls.map(call => result({
      buyOrders: [{ itemCode: call.input.itemCode, price: .0001, quantity: 100 }],
      sellOrders: [{ itemCode: call.input.itemCode, price: 90, quantity: 100 }]
    })) };
    throw Error("Unexpected message");
  } } };
};
const checks = async function () {
  const check = (value, text) => { if (!value) throw Error(text); };
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const native = document.querySelector("main"), before = native.innerHTML;
  const instance = __weAgoMarket.create(); instance.sync(); await flush();
  check(document.querySelectorAll(".we-ago-market-badge").length === 2, "native tiles annotated");
  const badges = [...document.querySelectorAll(".we-ago-market-badge")];
  for (const badge of badges) {
    const font = parseFloat(badge.style.fontSize);
    check(font >= 7 && font <= 14, "font range preserved");
    check(badge.scrollWidth <= badge.clientWidth || font === 7, "long percentages fit or reach documented minimum");
    // Confirm the search chooses exactly the largest fitting half-pixel size.
    const expected = badge.style.fontSize;
    if (font < 14) { badge.style.fontSize = `${font + .5}px`; check(badge.scrollWidth > badge.clientWidth, "font search retains largest fitting size"); }
    badge.style.fontSize = expected;
  }
  let nativeActivations = 0; native.addEventListener("click", () => { nativeActivations++; });
  badges[0].dispatchEvent(new MouseEvent("click", {bubbles:true,cancelable:true}));
  check(nativeActivations === 0 && !document.querySelector(".we-ago-market-callout").hidden, "owned badge tap opens details without activating native tile");
  badges[0].dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true}));
  check(document.querySelector(".we-ago-market-callout").hidden, "Escape dismisses details");
  badges[0].dispatchEvent(new KeyboardEvent("keydown", {key:"Enter",bubbles:true,cancelable:true}));
  check(!document.querySelector(".we-ago-market-callout").hidden, "keyboard activation opens details");
  const query = document.querySelectorAll, rects = Element.prototype.getClientRects;
  let queries = 0, measurements = 0;
  document.querySelectorAll = function (...args) { queries++; return query.apply(this, args); };
  Element.prototype.getClientRects = function (...args) { measurements++; return rects.apply(this, args); };
  const requests = calls.length;
  for (let i = 0; i < 60; i++) instance.tick();
  document.querySelectorAll = query; Element.prototype.getClientRects = rects;
  check(!queries && !measurements && calls.length === requests, "idle ticks do not rediscover, measure tiles or fetch fresh data");
  document.getElementById("steel-host").hidden = true; instance.sync();
  check(document.querySelectorAll(".we-ago-market-badge").length === 1, "visibility invalidation removes stale marker");
  document.getElementById("steel-host").hidden = false; instance.sync();
  check(document.querySelectorAll(".we-ago-market-badge").length === 2, "visibility restoration remounts");
  const lastKnown = document.querySelector(".we-ago-market-badge").textContent;
  window.holdMarket = true; advance(); instance.tick(); await flush();
  check(document.querySelector(".we-ago-market-badge").textContent === lastKnown, "market values remain visible during refresh");
  window.holdMarket = false; window.failMarket = true; releaseMarket(); await flush();
  check(document.querySelector(".we-ago-market-badge").textContent === lastKnown, "market values survive failed refresh");
  window.failMarket = false; advance(); instance.tick(); await flush();
  check(calls.length > requests, "clock refreshes expired market data");
  instance.destroy(); check(native.innerHTML === before, "native markup restored exactly");
  const count = calls.length; instance.tick(); instance.sync(); await flush(); check(calls.length === count, "destroy stops clock and discovery work");
  return "PASS market discovery reuse, bounded font fitting, visibility, expiry and native cleanup";
};
try {
  fs.writeFileSync(fixture, `<!doctype html><style>${fs.readFileSync("content/styles.css", "utf8")}
    [aria-haspopup]{display:inline-block} [id^="item-code-selector-"]{width:48px;height:48px} [hidden]{display:none!important}</style>
    <main><div id="steel-host" aria-haspopup="dialog"><div id="item-code-selector-steel"><img alt="steel"></div></div><div aria-haspopup="dialog"><div id="item-code-selector-concrete"><img alt="concrete"></div></div></main>
    <pre id="result"></pre><script>(${setup.toString()})();</script><script>${fs.readFileSync("content/ui.js", "utf8")}</script><script>(()=>{const location=testLocation;${fs.readFileSync("content/modules/market.js", "utf8")} })();</script>
    <script>(${checks.toString()})().then(text=>document.getElementById('result').textContent=text).catch(error=>document.getElementById('result').textContent='FAIL '+error.stack);</script>`);
  const run = spawnSync(chrome, ["--headless", "--disable-gpu", "--disable-background-networking", "--no-first-run",
    `--user-data-dir=${path.join(dir, "profile")}`, "--virtual-time-budget=3000", "--dump-dom", "file:///" + fixture.replaceAll("\\", "/")], { encoding: "utf8", timeout: 20000 });
  assert.equal(run.status, 0, run.stderr);
  const result = run.stdout.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1];
  assert(result?.startsWith("PASS"), result || run.stdout); console.log(result);
} finally { fs.unlinkSync(fixture); }
