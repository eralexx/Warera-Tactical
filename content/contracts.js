"use strict";

// Subscribe before the SPA loads its battle query. Only sanitized responses
// already fetched by the game cross worlds; no session credentials are read.
(() => {
  const channel = "we-ago-contract-read-v1";
  let enabled = false, revision = 0, latest;
  const battleId = () => /^\/battle\/([a-f\d]{24})\/?$/i.exec(location.pathname)?.[1];
  const receive = event => {
    const record = event.data?.record;
    if (!enabled || event.source !== window || event.origin !== location.origin || event.data?.channel !== channel
      || !record || record.battleId !== battleId() || typeof record.muId !== "string"
      || !Number.isFinite(record.receivedAt) || record.receivedAt > Date.now() || Date.now() - record.receivedAt >= 120000
      || !(record.contract === null || record.contract && typeof record.contract === "object")) return;
    latest = record;
  };
  function setEnabled(value) {
    if (enabled === value) return;
    enabled = value; latest = undefined;
    if (enabled) window.addEventListener("message", receive);
    else window.removeEventListener("message", receive);
    window.postMessage({ channel, subscribe: enabled }, location.origin);
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes["we-ago:features"]) {
      revision++;
      setEnabled(changes["we-ago:features"].newValue?.fullBurst !== false);
    }
    if (changes["we-ago:settings"]) latest = undefined;
  });
  const initialRevision = revision;
  void chrome.storage.local.get("we-ago:features").then(saved => {
    if (revision === initialRevision) setEnabled(saved["we-ago:features"]?.fullBurst !== false);
  }).catch(() => {});
  globalThis.__weAgoContracts = Object.freeze({ get(id, muId) {
    if (!enabled || id !== battleId() || latest?.battleId !== id || latest.muId !== muId
      || Date.now() - latest.receivedAt >= 120000) return undefined;
    return latest.contract;
  } });
})();
