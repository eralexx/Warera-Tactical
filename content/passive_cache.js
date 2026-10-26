"use strict";
(() => {
  if (globalThis.__weAgoPassiveCacheModule) return;
  const policy = globalThis.__weAgoPassiveCache;
  let instance, lifecycle = 0;
  function create() {
    let active = true, pending = false;
    const records = [];
    async function drain() {
      if (pending) return;
      pending = true;
      try {
        while (active && records.length) {
          await globalThis.__weAgoApi.send({ type: "WE_AGO_CACHE_WARM", record: records.shift() }).catch(() => {});
        }
      } finally { pending = false; }
    }
    const onMessage = event => {
      if (!active || event.source !== window || event.origin !== location.origin
        || event.data?.channel !== policy.channel || !policy.valid(event.data.record)) return;
      if (records.length < 100) records.push(event.data.record);
      void drain();
    };
    // Do not observe until the initial connection context is known.
    void globalThis.__weAgoApi.send({ type: "WE_AGO_CONTEXT_GET" }).then(() => {
      if (!active) return;
      window.addEventListener("message", onMessage);
      window.postMessage({ channel: policy.channel, subscribe: true }, location.origin);
    }).catch(() => {});
    return { destroy() {
      active = false;
      records.length = 0;
      window.removeEventListener("message", onMessage);
      window.postMessage({ channel: policy.channel, subscribe: false }, location.origin);
    } };
  }
  function stop() { instance?.destroy(); instance = undefined; }
  globalThis.__weAgoPassiveCacheModule = { create() {
    lifecycle++;
    instance ||= create();
    return { destroy() { lifecycle++; stop(); } };
  } };
  // The idle scheduler adopts this early instance instead of subscribing twice.
  const initial = lifecycle;
  void globalThis.__weAgoApi.send({ type: "WE_AGO_FEATURES_GET" }).then(reply => {
    if (lifecycle === initial && reply?.ok && reply.data.passiveCache) instance ||= create();
  }).catch(() => {});
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === "WE_AGO_FEATURES_CHANGED") {
      lifecycle++;
      if (message.features?.passiveCache) instance ||= create();
      else stop();
    }
    if (message?.type === "WE_AGO_CONTEXT_CHANGED" && message.connectionChanged) { lifecycle++; stop(); }
  });
})();
