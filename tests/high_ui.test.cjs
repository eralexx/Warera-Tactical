"use strict";

const assert = require("node:assert/strict"), fs = require("./runtime.cjs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("./browser.cjs");
const chrome = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "we-ago-high-ui-")), fixture = path.join(dir, "fixture.html");
const setup = function () {
  window.testLocation = { pathname: "/market" };
  let now = Date.now(); Date.now = () => now; window.advance = ms => { now += ms; };
  window.requests = []; const pending = [];
  window.chrome = { runtime: { sendMessage(message) { requests.push(message); return new Promise(resolve => pending.push(resolve)); } } };
  window.resolveBook = kind => pending.shift()(kind === "token" ? { ok: false, error: { code: "TOKEN_MISSING" } }
    : kind === "rate" ? { ok: false, error: { code: "HTTP_ERROR", httpStatus: 429 } }
      : { ok: true, data: { createdAt: now, expiresAt: now + 60000, data: {
        buyOrders: kind === "empty" ? [] : [{ itemCode: "steel", price: 1, quantity: 2 }],
        sellOrders: kind === "empty" ? [] : [{ itemCode: "steel", price: 2, quantity: 2 }]
      } } });
};
const checks = async function () {
  const check = (ok, message) => { if (!ok) throw Error(message); };
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const form = document.querySelector("form"), original = form.innerHTML;
  const instance = __weAgoUndercut.create(); instance.sync();
  const status = () => document.querySelector(".we-ago-undercut-status").textContent;
  check(status().includes("Loading"), "loading is visible while a read is pending");
  check([...document.querySelectorAll(".we-ago-undercut-button")].every(button => button.disabled), "unavailable prices cannot be used");
  resolveBook("token"); await flush(); check(status().includes("Settings → API connection"), "token failure has an existing recovery control");
  instance.tick(); check(requests.length === 1, "error status does not increase request rate");
  advance(31000); instance.tick(); resolveBook("empty"); await flush();
  check(status().includes("No active buy or sell orders"), "empty book differs from loading/failure");
  advance(61000); instance.tick(); resolveBook("ok"); await flush();
  check(status() === "", "successful retry clears error");
  const buttons = [...document.querySelectorAll(".we-ago-undercut-button")];
  check(buttons.every(button => !button.disabled && button.querySelector('svg[aria-label="Gold"]')), "usable quotes include accessible gold units");
  check(buttons[1].textContent.includes("Copy ask") && buttons[2].textContent.includes("Copy bid"), "bid and ask are explicit");
  check(document.querySelector('input[name="price"]').value === "7", "rendering never changes native price");
  const icon = buttons[0].querySelector("svg"); instance.tick(); check(icon === buttons[0].querySelector("svg"), "idle renders preserve unit nodes");
  const nativeCoinPath = document.getElementById("native-coin-path").dataset.path;
  check(icon.querySelector("path").getAttribute("d") === nativeCoinPath, "coin silhouette matches captured native game markup");
  advance(61000); instance.tick(); resolveBook("rate"); await flush(); check(status().includes("rate limited"), "rate-limit errors identify retry state");
  instance.destroy(); check(form.innerHTML === original, "disable restores native form exactly");
  const late = __weAgoUndercut.create(); late.sync(); late.destroy(); resolveBook("ok"); await flush();
  check(form.innerHTML === original, "late responses cannot restore disabled UI");
  const restored = __weAgoUndercut.create(); restored.sync(); resolveBook("ok"); await flush();
  check(document.querySelectorAll(".we-ago-undercut-button").length === 3, "reenable without reload");
  check(document.documentElement.scrollWidth <= innerWidth, "controls fit narrow viewport");
  check([...document.querySelectorAll('[data-we-ago="true"]')].every(node => [...node.classList].every(name => name.startsWith("we-ago-"))), "all injected nodes owned");
  return `PASS ${innerWidth}px native gold, loading/error/empty/recovery, backoff, native preservation and late-response cleanup`;
};
const markup = fs.readFileSync("tests/fixtures/mu-home-6a7d0f2a.html", "utf8");
const nativePath = markup.match(/<path d="(M12 5C7[^"]+)"/)[1];
try {
  for (const width of [390, 900]) {
    const html = `<!doctype html><meta charset="utf-8"><style>${fs.readFileSync("content/styles.css", "utf8")}
      body{margin:0;background:#0c201e;color:#b7d0ca;font:14px system-ui}section{margin:16px;padding:12px;border:1px solid #274744}input{width:100px;background:#071815;color:#b7d0ca}img{display:none}</style>
      <section id="headlessui-dialog-panel-fixture"><h2 id="headlessui-dialog-title-fixture">New Sell order</h2><form><img alt="steel" src="/images/itemsv2/steel.png"><label>Price <input name="price" value="7" step="any"></label><label>Quantity <input name="quantity" value="2"></label></form></section>
      <div id="native-coin-path" data-path="${nativePath}"></div><script>(${setup.toString()})();</script><script>${fs.readFileSync("content/ui.js", "utf8")}</script>
      <script>${fs.readFileSync("content/modules/market_undercut.js", "utf8").replace("(() => {", "(() => { const location = testLocation;")}</script>
      <script>(${checks.toString()})().then(t=>parent.postMessage(t,'*')).catch(e=>parent.postMessage('FAIL '+e.stack,'*'));</script>`;
    fs.writeFileSync(fixture, `<!doctype html><style>body{margin:0}iframe{width:${width}px;height:800px;border:0}</style><iframe></iframe><pre id="result" hidden></pre><script>addEventListener('message',e=>document.getElementById('result').textContent=e.data);document.querySelector('iframe').srcdoc=${JSON.stringify(html).replace(/</g, "\\u003c")};</script>`);
    const run = spawnSync(chrome, ["--headless", "--disable-gpu", "--disable-background-networking", "--no-first-run", `--user-data-dir=${path.join(dir, "profile-" + width)}`,
      `--window-size=${width},900`, "--virtual-time-budget=3000", "--dump-dom",
      ...(process.env.UX_SCREENSHOT_DIR ? [`--screenshot=${path.join(process.env.UX_SCREENSHOT_DIR, `high-ui-${width}.png`)}`] : []),
      require("node:url").pathToFileURL(fixture).href], { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 2e6 });
    assert.equal(run.status, 0, run.error?.message || run.stderr);
    const result = run.stdout.match(/<pre id="result"[^>]*>([^<]*)<\/pre>/)?.[1];
    assert.match(result ?? "No browser result", /^PASS /); console.log(result);
  }
} finally { fs.unlinkSync(fixture); }
