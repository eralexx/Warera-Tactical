"use strict";
// Deterministic vector artwork and actual extension-popup captures. No live game access.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const {playwright, chrome} = require("../tests/browser.cjs");
const root = path.resolve(__dirname, ".."), out = path.join(root, "store/assets");
const mark = fs.readFileSync(path.join(root, "assets/brand/mark.svg"), "utf8");
const uri = (text, mime = "image/svg+xml") => `data:${mime};base64,${Buffer.from(text).toString("base64")}`;
async function main() {
  fs.mkdirSync(out, {recursive:true}); fs.mkdirSync(path.join(root, "assets/icons"), {recursive:true});
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "warera-store-"));
  let context;
  try {
    context = await playwright().chromium.launchPersistentContext(profile, {executablePath:chrome(),headless:true,ignoreDefaultArgs:["--disable-extensions"],args:["--enable-unsafe-extension-debugging"],viewport:{width:1280,height:800},deviceScaleFactor:1});
    await context.route("**/*", route => route.request().url().startsWith("chrome-extension:") || route.request().url().startsWith("data:") ? route.continue() : route.abort());
    const page = await context.newPage();
    async function raster(svg, width, height, file, transparent = false) {
      await page.setViewportSize({width,height});
      await page.setContent(`<style>*{margin:0}html,body{width:100%;height:100%;overflow:hidden}</style>${svg}`);
      await page.screenshot({path:file,omitBackground:transparent});
    }
    for (const size of [16,32,48,128]) await raster(mark.replace('<svg ', `<svg width="${size}" height="${size}" `), size,size,path.join(root,`assets/icons/icon-${size}.png`),true);
    fs.copyFileSync(path.join(root,"assets/icons/icon-128.png"),path.join(out,"store-icon-128.png"));
    // Package-owned vector mark; no third-party game art or trademarks in the artwork.
    for (const [name,w,h] of [["promo-small",440,280],["promo-marquee",1400,560]]) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 1400 560"><defs><radialGradient id="g"><stop stop-color="#244c55"/><stop offset="1" stop-color="#101b2b"/></radialGradient></defs><rect width="1400" height="560" fill="url(#g)"/><g fill="none" stroke="#8ddfd0" opacity=".15" stroke-width="2"><circle cx="700" cy="280" r="230"/><circle cx="700" cy="280" r="170"/><path d="M0 280H1400M700 0V560M100 100L1300 460M100 460L1300 100"/></g><image href="${uri(mark)}" x="500" y="80" width="400" height="400"/></svg>`;
      fs.writeFileSync(path.join(out,`${name}.svg`),svg);
      await raster(svg,w,h,path.join(out,`${name}.png`));
    }
    // Render the real popup files with deterministic, empty-profile transport data.
    // Keep this fixture explicit: it does not validate service-worker integration.
    await context.unroute("**/*");
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.protocol === "data:") return route.continue();
      const allowed = new Set(["popup.html","popup.css","popup.js","i18n.js","shared/features.js","locales/es.js"]);
      const file = url.pathname.slice(1);
      if (url.origin !== "https://extension-preview.invalid" || !allowed.has(file)) return route.abort();
      return route.fulfill({body:fs.readFileSync(path.join(root,file)),contentType:file.endsWith(".html")?"text/html":file.endsWith(".css")?"text/css":"application/javascript"});
    });
    await context.addInitScript(() => {
      window.chrome = {runtime:{id:"store-fixture",onMessage:{addListener(){}},async sendMessage(message) {
        const values = {
          WE_AGO_LANGUAGE_GET:{language:"en"},
          WE_AGO_FEATURES_GET:Object.fromEntries((window.__weAgoFeatures || []).map(({key})=>[key,true])),
          WE_AGO_SETTINGS_GET:{hasToken:false,userId:"",apiProvider:"official",ttls:{live:120,static:600,default:120}},
          WE_AGO_RADAR_GET:{settings:{minimumBounty:1}},
          WE_AGO_DISPLAY_GET:{marketFontSize:11}
        };
        return {ok:true,data:values[message.type] || {}};
      }},storage:{onChanged:{addListener(){}}}};
    });
    const popup = await context.newPage(); await popup.setViewportSize({width:420,height:600});
    popup.on("pageerror", error => console.error("Popup:",error.message));
    await popup.goto("https://extension-preview.invalid/popup.html");
    await popup.waitForFunction(() => !document.querySelector("#feature-market").disabled);
    const shots = [
      {name:"01-features",title:"Your tactical toolkit.",lines:["Choose your features.","Apply changes to open WarEra tabs."],selector:"header"},
      {name:"02-connection",title:"Your connection. Your control.",lines:["Official and Community Gateway access.","Local settings. Clear sharing disclosure."],selector:"#api-menu"}
    ];
    for (const shot of shots) {
      if (shot.selector !== "header") await popup.locator(shot.selector).evaluate(el => {el.open=true; el.scrollIntoView({block:"start"});});
      const buffer = await popup.screenshot({path:path.join(out,`${shot.name}-raw.png`)});
      const frame = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="#101b2b"/><image href="${uri(mark)}" x="64" y="62" width="96" height="96"/><g font-family="Arial,sans-serif"><text x="64" y="214" fill="#8ddfd0" font-size="22" letter-spacing="3">WARERA TACTICAL</text><text x="64" y="286" fill="#edf4ff" font-size="36" font-weight="700">${shot.title}</text><text x="64" y="348" fill="#bacbdd" font-size="20">${shot.lines[0]}</text><text x="64" y="384" fill="#bacbdd" font-size="20">${shot.lines[1]}</text><text x="64" y="724" fill="#8eabc1" font-size="17">Read-only companion for WarEra</text></g><image href="data:image/png;base64,${buffer.toString("base64")}" x="790" y="100" width="420" height="600"/></svg>`;
      await raster(frame,1280,800,path.join(out,`${shot.name}.png`));
    }
    console.log("Created 4 runtime icons, store icon, 2 promotional images, 2 popup-source fixture screenshots and raw captures.");
  } finally {
    if (context) await context.close();
    const resolved = path.resolve(profile);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("warera-store-")) throw Error("Unsafe profile path");
    fs.rmSync(resolved,{recursive:true,force:true});
  }
}
main().catch(error => {console.error(error); process.exitCode=1;});
