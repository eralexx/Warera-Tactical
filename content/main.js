"use strict";

(() => {
  globalThis.__weAgoTopbar?.destroy();
  const factories = Object.fromEntries(globalThis.__weAgoFeatures.map(({key, factory}) => [key, globalThis[factory]]));
  const modules = {};
  let features = Object.fromEntries(Object.keys(factories).map(key => [key, false]));
  let featuresReceived = false;
  let stopped = false;
  let syncedUrl;
  let viewportTimer;
  let timer;
  let stopObserver = () => {}, observing = false;
  function updateScheduling() {
    const visible = !stopped && !document.hidden;
    const instances = Object.values(modules);
    const wanted = visible && instances.some(instance => instance?.sync);
    if (wanted && !observing) { observing = true; stopObserver = globalThis.__weAgoRouteObserver.start(syncFeatures); }
    else if (!wanted && observing) { observing = false; stopObserver(); stopObserver = () => {}; }
    const clockWanted = visible && instances.some(instance => instance?.tick || instance?.sync);
    if (clockWanted && timer === undefined) timer = setInterval(tickFeatures, 1000);
    else if (!clockWanted && timer !== undefined) { clearInterval(timer); timer = undefined; }
    if (!wanted) { clearTimeout(viewportTimer); viewportTimer = undefined; }
  }

  const failures = new Map();
  function invoke(key, method, ...args) {
    try { return (method === "create" ? factories[key] : modules[key])?.[method]?.(...args); }
    catch {
      if (!failures.has(key)) { failures.set(key, true); globalThis.console?.warn?.("WarEra UI feature failed:", key, method); }
    }
  }
  function syncFeatures(change = {}) {
    if (stopped || document.hidden) return;
    if (viewportTimer !== undefined) { clearTimeout(viewportTimer); viewportTimer = undefined; }
    const changedRoute = syncedUrl !== globalThis.location?.href;
    syncedUrl = globalThis.location?.href;
    const shared = new Map();
    for (const key of Object.keys(modules)) {
      const routes = {market:["market"],marketUndercut:["market"],battle:["battle"],countryBuilds:["country","mu"],spyXray:["country","mu","battle","user"],pillTimeline:["country","mu"],companyAdvisor:["companies"],equipmentCped:["market"],pillRoi:["battle"],fullBurst:["battle"]}[key];
      const route = syncedUrl?.replace(/^https?:\/\/[^/]+\//, "").split(/[/?#]/)[0];
      if (!changedRoute && change.reason === "mutation" && routes && !routes.includes(route)) continue;
      invoke(key, "sync", { shared, reason:change.reason });
    }
  }

  function applyFeatures(next) {
    if (stopped || !next || Object.keys(features).some(key => typeof next[key] !== "boolean")) return;
    features = { ...next };
    for (const [key, factory] of Object.entries(factories)) {
      if (!features[key]) {
        invoke(key, "destroy");
        delete modules[key];
      } else if (!modules[key] && factory) {
        const instance = invoke(key, "create");
        if (instance) modules[key] = instance;
      }
    }
    updateScheduling();
    syncFeatures();
  }

  const onFeaturesMessage = (message, sender) => {
    if (sender.id === chrome.runtime.id && message?.type === "WE_AGO_CONTEXT_CHANGED") {
      const affected = message.connectionChanged ? Object.keys(modules) : globalThis.__weAgoFeatures.filter(feature => feature.player).map(feature => feature.key);
      for (const key of affected) { invoke(key, "destroy"); delete modules[key]; }
      applyFeatures(features);
    }
    if (sender.id === chrome.runtime.id && message?.type === "WE_AGO_FEATURES_CHANGED") {
      featuresReceived = true;
      applyFeatures(message.features);
    }
  };
  chrome.runtime.onMessage.addListener(onFeaturesMessage);
  // Register the listener first so a delayed initial read cannot undo a save.
  void chrome.runtime.sendMessage({ type: "WE_AGO_FEATURES_GET" }).then(async response => {
    await globalThis.__weAgoI18n?.ready;
    if (response?.ok && !featuresReceived) applyFeatures(response.data);
  }).catch(() => { /* Keep features inactive if preferences cannot be read. */ });

  const stopLanguage = globalThis.__weAgoI18n?.subscribe(() => {
    const owned = () => [...(document.querySelectorAll?.('[data-we-ago="true"]') || [])].filter(node => node.matches?.("input, select, details, .we-ago-radar-panel, .we-ago-country-scroll, .we-ago-market-callout") || node.scrollTop);
    const nodes = owned();
    const keys = list => { const counts = new Map(); return list.map(node => { const base = node.id || [node.tagName,node.className,node.name || ""].join(":"); const index = counts.get(base) || 0; counts.set(base,index+1); return base + ":" + index; }); };
    const nodeKeys = keys(nodes);
    const state = new Map(nodes.map((node,index) => [nodeKeys[index], { value: node.value, checked: node.checked, open: node.open, scrollTop: node.scrollTop, focused: document.activeElement === node, start: node.selectionStart, end: node.selectionEnd }]));
    const moduleState = Object.fromEntries(Object.keys(modules).map(key => [key, invoke(key, "snapshotState")]));
    // Recreate only enabled modules through their existing cancellation/cleanup paths.
    // Cached reads are retained by the worker; late responses belong to destroyed instances.
    for (const [key, instance] of Object.entries(modules)) {
      invoke(key, "destroy");
      delete modules[key];
    }
    applyFeatures(features);
    for (const key of Object.keys(modules)) invoke(key, "restoreState", moduleState[key]);
    const restored = owned(), restoredKeys = keys(restored);
    restored.forEach((node, index) => {
      const saved = state.get(restoredKeys[index]); if (!saved) return;
      if (saved.value !== undefined && node.value !== undefined) { node.value = saved.value; const form = node.closest?.("form"); if (form) form.dataset.weAgoDraft = "true"; }
      if (saved.checked !== undefined) node.checked = saved.checked;
      if (saved.open !== undefined) { node.dataset.weAgoRestoredOpen = String(saved.open); node.open = saved.open; }
      node.scrollTop = saved.scrollTop;
      if (saved.focused) { node.focus?.({preventScroll:true}); try { node.setSelectionRange?.(saved.start,saved.end); } catch {} }
    });
    syncFeatures();
  });

  function tickFeatures() {
    if (stopped || document.hidden) return;
    // A timer advances clocks/expiry, not native DOM discovery. Navigation is
    // checked here too so a delayed observer cannot keep ticking an old route.
    if (syncedUrl !== globalThis.location?.href) syncFeatures();
    else for (const [key, instance] of Object.entries(modules)) {
      invoke(key, instance?.tick ? "tick" : "sync");
    }
  }
  const onVisible = () => {
    updateScheduling();
    if (!document.hidden) {
      syncFeatures();
    }
  };
  document.addEventListener("visibilitychange", onVisible);
  // Geometry and native input properties can change without a childList
  // mutation. Share one bounded reconciliation across all interested modules.
  const onViewport = () => {
    if (stopped || document.hidden || !Object.values(modules).some(instance => instance?.sync) || viewportTimer !== undefined) return;
    viewportTimer = setTimeout(() => { viewportTimer = undefined; syncFeatures(); }, 100);
  };
  const onNativeEdit = event => {
    if (!event.target?.closest?.('[data-we-ago="true"]')) onViewport();
  };
  const onDisclosure = event => {
    if (event.target?.matches?.("details")) onViewport();
  };
  document.addEventListener("scroll", onViewport, true);
  document.addEventListener("input", onNativeEdit, true);
  document.addEventListener("change", onNativeEdit, true);
  document.addEventListener("toggle", onDisclosure, true);
  globalThis.addEventListener?.("resize", onViewport);
  globalThis.__weAgoTopbar = {
    destroy() {
      stopped = true;
      stopLanguage?.();
      for (const key of Object.keys(modules)) invoke(key, "destroy");
      chrome.runtime.onMessage.removeListener(onFeaturesMessage);
      stopObserver();
      clearInterval(timer);
      clearTimeout(viewportTimer);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("scroll", onViewport, true);
      document.removeEventListener("input", onNativeEdit, true);
      document.removeEventListener("change", onNativeEdit, true);
      document.removeEventListener("toggle", onDisclosure, true);
      globalThis.removeEventListener?.("resize", onViewport);
    }
  };
})();

