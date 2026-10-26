"use strict";
const assert = require("node:assert/strict"), fs = require("./runtime.cjs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("./browser.cjs");
const read = file => fs.readFileSync(file, "utf8");
const setup = function () {
  const runtimeListeners = new Set(), storageListeners = new Set();
  const keys = ["market", "marketUndercut", "battle", "spyXray", "pillTimeline", "companyAdvisor", "netSalary", "bountyRadar", "countryBuilds", "contractRadar", "lootRadar", "lootRoundTimer", "equipmentCped", "pillRoi", "fullBurst", "passiveCache"];
  window.flags = Object.fromEntries(keys.map(key => [key, key === "marketUndercut"]));
  window.testLocation = { href: "https://app.warera.io/market", pathname: "/market" };
  window.requests = []; let language = "es";
  window.originalForm = document.querySelector("form")?.innerHTML;
  window.emitFlags = next => {
    Object.assign(flags, next);
    for (const fn of runtimeListeners) fn({ type: "WE_AGO_FEATURES_CHANGED", features: { ...flags } }, { id: "test" });
  };
  window.chrome = { storage: { onChanged: { addListener(fn) { storageListeners.add(fn); } } }, runtime: {
    id: "test", onMessage: { addListener(fn) { runtimeListeners.add(fn); }, removeListener(fn) { runtimeListeners.delete(fn); } },
    async sendMessage(message) {
      requests.push(message);
      const data = {
        WE_AGO_LANGUAGE_GET: { language }, WE_AGO_FEATURES_GET: flags,
        WE_AGO_RADAR_GET: { settings: { minimumBounty: 2 } }, WE_AGO_DISPLAY_GET: { marketFontSize: 11 },
        WE_AGO_SETTINGS_GET: { hasToken: true, userId: "a".repeat(24), apiProvider: "official", ttls: { live: 60, static: 300, default: 60 } },
        WE_AGO_QUERY: { createdAt: Date.now(), expiresAt: Date.now() + 60000, data: {
          buyOrders: [{ itemCode: "steel", price: 1, quantity: 2 }], sellOrders: [{ itemCode: "steel", price: 2, quantity: 2 }] } }
      };
      if (message.type === "WE_AGO_LANGUAGE_SAVE") {
        language = message.language;
        for (const fn of storageListeners) fn({ "we-ago:language": { newValue: language } }, "local");
        for (const fn of runtimeListeners) fn({ type: "WE_AGO_LANGUAGE_CHANGED", language }, { id: "test" });
        return { ok: true, data: { language } };
      }
      if (!(message.type in data)) throw Error("Unexpected message: " + message.type);
      return { ok: true, data: data[message.type] };
    }
  } };
  window.__weAgoRouteObserver = { start(fn) { fn(); return () => {}; } };
};
const checkPopup = async function () {
  const check = (ok, text) => { if (!ok) throw Error(text); };
  const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  await flush();
  const language = document.getElementById("language"), token = document.getElementById("token");
  check(document.documentElement.lang === "es", "saved Spanish restored");
  check(document.querySelector("h1").textContent === "Configuración", "heading translated");
  check(language.value === "es" && !language.disabled, "persisted selector enabled after startup");
  check(document.getElementById("token-state").textContent === "Hay un token guardado.", "dynamic connection state translated");
  check(token.placeholder.includes("Pega el token"), "placeholder translated");
  check(!document.getElementById("feature-market").checked, "saved disabled feature preserved");
  token.value = "unsaved-token"; document.getElementById("radar-bounty").value = "7";
  language.value = "en"; language.dispatchEvent(new Event("change")); await flush();
  check(document.querySelector("h1").textContent === "Settings", "switch back to English");
  check(token.value === "unsaved-token" && document.getElementById("radar-bounty").value === "7", "language change preserves unsaved fields");
  check(!document.getElementById("feature-market").checked, "language change preserves flags");
  language.value = "es"; language.dispatchEvent(new Event("change")); await flush();
  check(document.getElementById("language-status").textContent === "Idioma guardado.", "save confirmation translated");
  const all = [...document.querySelectorAll("body *")];
  const unmarked = all.filter(n => !n.children.length && /[a-zA-Z]/.test(n.textContent)).filter(n =>
    !(n.tagName === "SCRIPT" || n.closest("[data-i18n]") || n.closest("[role=status]") || ["token-state", "connection-state", "market-font-value", "market-font-preview", "cache-count"].includes(n.id) || n.tagName === "OPTION" || n.classList.contains("eyebrow")));
  check(!unmarked.length, "all popup static copy explicitly marked: " + unmarked.map(n => n.textContent).join(" | "));
  check(document.body.scrollWidth <= 420, "Spanish fits popup width: " + document.body.scrollWidth);
  return "PASS Spanish popup labels, placeholders, dynamic states, persisted flags, repeated switch and unsaved edits";
};
const checkContent = async function () {
  const check = (ok, text) => { if (!ok) throw Error(text); };
  const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  const form = document.querySelector("form"), original = originalForm;
  await flush();
  check(document.querySelectorAll(".we-ago-undercut-button").length === 3, "enabled module mounted");
  const buttons = () => [...document.querySelectorAll(".we-ago-undercut-button")];
  check(buttons()[1].textContent.includes("Copiar venta"), "Spanish action label");
  check(buttons()[0].querySelector('svg[aria-label="Oro"]'), "Spanish accessibility label");
  check(form.querySelector("input").value === "7", "native input unchanged");
  const nativeText = [...form.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("");
  check(nativeText.includes("Health"), "native game text unchanged");
  await chrome.runtime.sendMessage({ type: "WE_AGO_LANGUAGE_SAVE", language: "en" }); await flush();
  check(buttons()[1].textContent.includes("Copy ask"), "live module rebuilt in English");
  check(buttons().length === 3, "no duplicated controls after rebuild");
  await chrome.runtime.sendMessage({ type: "WE_AGO_LANGUAGE_SAVE", language: "es" }); await flush();
  check(buttons()[1].textContent.includes("Copiar venta"), "live Spanish restored");
  emitFlags({ marketUndercut: false }); await flush();
  check(form.innerHTML === original, "feature off removes translated UI");
  await chrome.runtime.sendMessage({ type: "WE_AGO_LANGUAGE_SAVE", language: "en" }); await flush();
  check(!buttons().length, "language changes cannot enable disabled features");
  emitFlags({ marketUndercut: true }); await flush();
  check(buttons()[1].textContent.includes("Copy ask"), "feature reenabled in selected language without reload");
  __weAgoTopbar.destroy();
  check(form.innerHTML === original, "destroy removes UI and preserves all native markup");
  check(!document.querySelector('[data-we-ago="true"]'), "no extension UI remains");
  check(requests.every(r => !r.method || r.method === "GET"), "read-only fixture traffic");
  return "PASS Spanish content, live English/Spanish rebuild, accessibility, native preservation and teardown";
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "we-ago-localization-"));
const chrome = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
for (const kind of ["popup", "content"]) {
  let html;
  const script = source => `<script>${source}</script>`;
  if (kind === "popup") {
    html = read("popup.html").replace(/<script src="([^"]+)" defer><\/script>/g, (_, file) => script(read(file)))
      .replace('<link rel="stylesheet" href="popup.css">', `<style>${read("popup.css")}</style>`);
    // Preserve defer semantics when replacing external scripts with local inline fixtures.
    const scripts = [...html.matchAll(/<script>[\s\S]*?<\/script>/g)].map(m => m[0]).join("");
    html = html.replace(/<script>[\s\S]*?<\/script>/g, "").replace("</body>", script(`(${setup.toString()})()`)+scripts+script(`(${checkPopup.toString()})().then(report).catch(e=>report('FAIL '+e.stack));`)+"</body>");
  } else {
    html = `<!doctype html><meta charset="utf-8"><style>${read("content/styles.css")}</style>
      <section id="headlessui-dialog-panel-test"><h2 id="headlessui-dialog-title-test">New Sell order</h2><form>Health<label>Price <input name="price" value="7" step="any"></label><input name="quantity" value="2"><img alt="steel" src="/images/itemsv2/steel.png"></form></section>`
      + script(`(${setup.toString()})()`)
      + ["locales/es.js", "i18n.js", "content/ui.js", "content/modules/market_undercut.js", "content/main.js"].map(file => script(read(file).replace("(() => {", "(() => { const location = testLocation;"))).join("")
      + script(`(${checkContent.toString()})().then(report).catch(e=>report('FAIL '+e.stack));`);
  }
  html = html.replace(/<!doctype html>/i, '<!doctype html><script>function report(text){const p=document.createElement("pre");p.id="test-result";p.hidden=true;p.textContent=text;document.body.append(p);}</script>');
  const fixture = path.join(dir, kind + ".html"); fs.writeFileSync(fixture, html);
  const result = spawnSync(chrome, ["--headless", "--disable-gpu", "--disable-background-networking", "--no-first-run",
    `--user-data-dir=${path.join(dir, "profile-" + kind)}`, "--window-size=440,900", "--virtual-time-budget=3000", "--dump-dom",
    ...(kind === "popup" && process.env.UX_SCREENSHOT_DIR ? [`--screenshot=${path.join(process.env.UX_SCREENSHOT_DIR, "localization-popup-es.png")}`] : []),
    require("node:url").pathToFileURL(fixture).href], { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 3e6 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const report = result.stdout.match(/<pre id="test-result"[^>]*>([^<]*)<\/pre>/)?.[1];
  assert.match(report || "No browser result", /^PASS /); console.log(report);
  fs.unlinkSync(fixture);
}
