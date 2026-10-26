"use strict";

const t = (source = "", ...values) => globalThis.__weAgoI18n?.t(source, ...values)
    ?? (typeof source === "string" ? source : source.reduce((text, part, i) => text + part + (i < values.length ? values[i] : ""), ""));


const element = id => document.getElementById(id);
let hasSavedToken = false, settingsLoaded = false;
let cacheOffset = 0, cacheRevision = 0, cachePage;
function localizePopup() {
  globalThis.__weAgoI18n?.localize(document);
  element("language").value = globalThis.__weAgoI18n?.language || "en";
  element("token-state").textContent = hasSavedToken ? t("A token is saved.") : t("No token saved.");
  element("connection-state").textContent = hasSavedToken ? t("Token saved") : t("No token");
}
globalThis.__weAgoI18n?.subscribe(() => {
  localizePopup();
  for (const id of ["status", "display-status", "features-status", "language-status", "connection-status", "radar-status", "cache-status"]) element(id).textContent = "";
  if (element("settings-form").dataset?.loadFailed === "true") element("cache-status").textContent = t("Retry API connection settings.");
  if (cachePage) renderCache();
});
element("language").addEventListener("change", () => {
  const language = element("language").value;
  void runIn("language", async () => {
    try {
      const saved = await send("WE_AGO_LANGUAGE_SAVE", { language });
      globalThis.__weAgoI18n?.setLanguage(saved.language);
      localizePopup();
      element("language-status").textContent = t("Language saved.");
    } catch (error) {
      element("language").value = globalThis.__weAgoI18n?.language || "en";
      throw error;
    }
  });
});
const featureKeys = globalThis.__weAgoFeatures.map(feature => feature.key);
if (document.createElement) {
  const form = element("features-form");
  for (const group of ["Market", "Battle", "Country & MU", "Company", "Radar", "Data"]) {
    const fieldset = document.createElement("fieldset"), legend = document.createElement("legend");
    fieldset.className = "feature-group"; legend.dataset.i18n = group; legend.textContent = t(group); fieldset.append(legend);
    for (const feature of globalThis.__weAgoFeatures.filter(feature => feature.group === group)) fieldset.append(element("feature-" + feature.key).closest("label"));
    form.insertBefore(fieldset, form.querySelector(".hint"));
  }
}

async function send(type, fields = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...fields });
  if (!response?.ok) throw new Error(response?.error?.message || t("The service worker did not respond."));
  return response.data;
}

function applySettings(settings, { connection = true, cache = true } = {}) {
  hasSavedToken = Boolean(settings.hasToken);
  for (const feature of globalThis.__weAgoFeatures) {
    const control = element("feature-" + feature.key);
    control.title = !settings.hasToken ? t("Save an API token in Settings → API connection.") : feature.player && !settings.userId ? t("Set API token and player ID in Settings → API connection.") : "";
  }
  if (connection) {
    element("token").value = "";
    element("player-id").value = settings.userId || "";
    element("api-official").checked = settings.apiProvider !== "gateway";
    element("api-gateway").checked = settings.apiProvider === "gateway";
  }
  element("token-state").textContent = settings.hasToken ? t("A token is saved.") : t("No token saved.");
  element("connection-state").textContent = settings.hasToken ? t("Token saved") : t("No token");
  if (cache) {
    for (const group of ["live", "static", "default"]) element("ttl-" + group).value = settings.ttls[group];
    element("cache-status").textContent = "";
  }
  settingsLoaded = true;
}

function previewFont() {
  const size = Number(element("market-font-size").value);
  element("market-font-value").textContent = `${size} px`;
  element("market-font-preview").style.fontSize = `${size}px`;
}

element("market-font-size").addEventListener("input", previewFont);
element("reset-display").addEventListener("click", () => {
  element("market-font-size").value = "11";
  previewFont();
});
element("display-form").addEventListener("submit", event => {
  event.preventDefault();
  const marketFontSize = Number(element("market-font-size").value);
  void runIn("display-form", async () => {
    element("display-status").textContent = t("Saving…");
    try {
      const display = await send("WE_AGO_DISPLAY_SAVE", { marketFontSize });
      element("market-font-size").value = String(display.marketFontSize);
      previewFont();
      element("display-status").textContent = t("Display settings saved.");
    } catch (error) {
      element("display-status").textContent = t(error.message) || t("Could not save display settings.");
      throw error;
    }
  });
});

async function refreshCache(offset = cacheOffset) {
  const revision = ++cacheRevision;
  let page;
  try { page = await send("WE_AGO_CACHE_LIST", {paged:true, offset, limit:50}); }
  catch (error) { if (revision === cacheRevision) throw error; return; }
  if (revision !== cacheRevision) return;
  cachePage = page;
  renderCache();
}
function renderCache() {
  const page = cachePage;
  const entries = Array.isArray(page) ? page : page.entries;
  const total = Array.isArray(page) ? page.length : page.total;
  cacheOffset = Array.isArray(page) ? cacheOffset : page.offset;
  const number = value => value.toLocaleString(globalThis.__weAgoI18n?.locale);
  element("cache-count").textContent = entries.length
    ? number(cacheOffset + 1) + "–" + number(cacheOffset + entries.length) + " / " + number(total) : "0 / " + number(total);
  if (element("cache-prev")) { const control = element("cache-prev"); if (control.dataset) control.dataset.keepDisabled = String(cacheOffset === 0); syncDisabled(control); }
  if (element("cache-next")) { const control = element("cache-next"); if (control.dataset) control.dataset.keepDisabled = String(cacheOffset + 50 >= total); syncDisabled(control); }
  const list = element("cache-list");
  list.replaceChildren();
  if (!entries.length) {
    const item = document.createElement("li");
    item.textContent = t("No cached responses.");
    list.append(item);
  }
  for (const entry of entries) {
    const item = document.createElement("li");
    const label = document.createElement("strong");
    label.textContent = `${entry.procedure} · ${entry.provider === "gateway" ? t("Gateway") : t("Official")}`;
    const key = document.createElement("code");
    key.textContent = entry.key;
    const expiry = document.createElement("span");
    expiry.textContent = (entry.expiresAt <= Date.now() ? t("Expired ") : t("Expires ")) + new Date(entry.expiresAt).toLocaleString(globalThis.__weAgoI18n?.locale);
    item.append(label, key, expiry);
    list.append(item);
  }
}

const locks = new WeakMap();
function blocked(control) {
  if (control.matches?.(".retry-load")) return false;
  return control.closest?.("form")?.dataset.loadFailed === "true"
    || !settingsLoaded && Boolean(control.closest?.("#cache-form"));
}
function syncDisabled(control) {
  control.disabled = (locks.get(control) || 0) > 0 || control.dataset?.keepDisabled === "true" || blocked(control);
}
function sectionStatus(scope) {
  return element(({"settings-form":"connection-status", "radar-form":"radar-status", "cache-form":"cache-status", "cache-menu":"cache-status", "features-form":"features-status", "display-form":"display-status", "language":"language-status"})[scope?.id] || "status");
}
async function run(action, scope = document) {
  const own = scope.matches?.("input, select, button") ? [scope] : scope.querySelectorAll?.("button, input, select") || document.querySelectorAll("button, input, select");
  const dependent = scope.id === "settings-form" && !settingsLoaded
    ? element("cache-form").querySelectorAll?.("button, input, select") || [] : [];
  const controls = [...new Set([...own, ...dependent])];
  sectionStatus(scope).classList.toggle("error", false);
  controls.forEach(control => { locks.set(control, (locks.get(control) || 0) + 1); control.disabled = true; });
  try { await action(); return true; }
  catch (error) { const target = sectionStatus(scope); target.textContent = t(error.message) || t("Operation failed. Try again."); target.classList.toggle("error", true); return false; }
  finally { controls.forEach(control => { locks.set(control, (locks.get(control) || 1) - 1); syncDisabled(control); }); }
}
const runIn = (id, action) => run(action, element(id));

element("settings-form").addEventListener("submit", event => {
  event.preventDefault();
  // Read before disabling controls; a blank field preserves an existing token.
  const token = element("token").value.trim();
  const fields = {
    apiProvider: element("api-gateway").checked ? "gateway" : "official",
    userId: element("player-id").value.trim()
  };
  if (token) fields.token = token;
  void runIn("settings-form", async () => {
    applySettings(await send("WE_AGO_SETTINGS_SAVE", fields), { cache: false });
    if (element("cache-menu").open) void runIn("cache-menu", refreshCache);
    sectionStatus(element("settings-form")).textContent = t("Connection saved.");
  });
});

element("features-form").addEventListener("submit", event => {
  event.preventDefault();
  const features = Object.fromEntries(featureKeys.map(key => [key, element("feature-" + key).checked]));
  void runIn("features-form", async () => {
    element("features-status").textContent = t("Saving…");
    try {
      applyFeatures(await send("WE_AGO_FEATURES_SAVE", { features }));
      element("features-status").textContent = t("Features saved.");
    } catch (error) {
      element("features-status").textContent = t("Could not save features.");
      throw error;
    }
  });
});

function applyFeatures(features) {
  for (const key of featureKeys) element("feature-" + key).checked = features[key];
}

function applyRadar(settings) {
  element("radar-bounty").value = settings.minimumBounty;
}

element("radar-form").addEventListener("submit", event => {
  event.preventDefault();
  const settings = {
    minimumBounty: Number(element("radar-bounty").value)
  };
  void runIn("radar-form", async () => {
    applyRadar(await send("WE_AGO_RADAR_SAVE", { settings }));
    sectionStatus(element("radar-form")).textContent = t("Radar settings saved.");
  });
});

element("cache-form").addEventListener("submit", event => {
  event.preventDefault();
  const ttls = Object.fromEntries(["live", "static", "default"].map(group => [group, Number(element("ttl-" + group).value)]));
  void runIn("cache-form", async () => {
    const settings = await send("WE_AGO_SETTINGS_SAVE", { ttls });
    for (const group of ["live", "static", "default"]) element("ttl-" + group).value = settings.ttls[group];
    sectionStatus(element("cache-form")).textContent = t("Cache settings saved.");
  });
});

element("cache-menu").addEventListener("toggle", () => {
  if (element("cache-menu").open) void runIn("cache-menu", refreshCache);
});

element("remove-token").addEventListener("click", () => void runIn("settings-form", async () => {
  applySettings(await send("WE_AGO_SETTINGS_SAVE", { token: "" }), { connection: false, cache: false });
  element("token").value = "";
  if (element("cache-menu").open) void runIn("cache-menu", refreshCache);
  sectionStatus(element("settings-form")).textContent = t("Saved token and cached responses removed.");
}));

element("refresh-cache").addEventListener("click", () => void runIn("cache-menu", async () => {
  await refreshCache();
  sectionStatus(element("cache-menu")).textContent = t("Cache list refreshed.");
}));

element("clear-cache").addEventListener("click", () => void runIn("cache-menu", async () => {
  const result = await send("WE_AGO_CACHE_CLEAR");
  cacheOffset = 0;
  await refreshCache();
  sectionStatus(element("cache-menu")).textContent = t`Cleared ${result.removed} cached response(s).`;
}));

for (const [id, direction] of [["cache-prev",-1],["cache-next",1]]) element(id).addEventListener("click", () => {
  const offset = Math.max(0, cacheOffset + 50 * direction);
  void runIn("cache-menu", () => refreshCache(offset));
});

const startup = [
  ["WE_AGO_RADAR_GET", "radar-form", radar => applyRadar(radar.settings)],
  ["WE_AGO_FEATURES_GET", "features-form", applyFeatures],
  ["WE_AGO_DISPLAY_GET", "display-form", display => { element("market-font-size").value = String(display.marketFontSize); previewFont(); }],
  ["WE_AGO_SETTINGS_GET", "settings-form", applySettings]
];
for (const [type, id, apply] of startup) {
  const scope = element(id);
  const load = async () => {
    const ok = await runIn(id, async () => {
      const data = await send(type);
      await globalThis.__weAgoI18n?.ready;
      apply(data); localizePopup();
      scope.querySelector?.(".retry-load")?.remove();
    });
    if (scope.dataset) scope.dataset.loadFailed = String(!ok);
    if (ok) scope.querySelectorAll?.("button, input, select").forEach(syncDisabled);
    if (!ok && document.createElement) {
      scope.querySelectorAll("button, input, select").forEach(control => {control.disabled = true;});
      if (id === "settings-form") {
        element("cache-form").querySelectorAll("button, input, select").forEach(control => { control.disabled = true; });
        element("cache-status").textContent = t("Retry API connection settings.");
      }
      let retry = scope.querySelector(".retry-load");
      if (!retry) {
        retry = document.createElement("button"); retry.type = "button"; retry.className = "retry-load"; retry.textContent = t("Retry");
        retry.addEventListener("click", () => { const target = sectionStatus(scope); target.classList.remove("error"); target.textContent = ""; void load(); }); scope.append(retry);
      }
      retry.disabled = false;
    }
  };
  void load();
}
void Promise.resolve(globalThis.__weAgoI18n?.ready).then(() => { localizePopup(); element("language").disabled = false; });
