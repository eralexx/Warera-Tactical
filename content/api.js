"use strict";
(() => {
  if (globalThis.__weAgoApi) return;
  let revision = 0, received = false, loaded = false;
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id === chrome.runtime.id && message?.type === "WE_AGO_CONTEXT_CHANGED" && Number.isSafeInteger(message.revision)) {
      received = true; revision = Math.max(revision, message.revision);
    }
  });
  let ready;
  function load() {
    if (!ready) {
      ready = chrome.runtime.sendMessage({type:"WE_AGO_CONTEXT_GET"}).then(response => {
        if (!response?.ok) throw new Error("Connection context unavailable.");
        if (!received) revision = response.data.revision;
        loaded = true;
      }).catch(error => { ready = undefined; throw error; });
      void ready.catch(() => {});
    }
    return ready;
  }
  void load();
  globalThis.__weAgoApi = Object.freeze({ /** @param {ReadMessage} message @returns {Promise<ReadReply>} */ async send(message) {
    const previousRevision = loaded ? revision : undefined;
    await load();
    if (previousRevision !== undefined && previousRevision !== revision) throw Object.assign(new Error("Connection changed."),{code:"CONTEXT_CHANGED"});
    const contextRevision = revision;
    const response = await chrome.runtime.sendMessage({...message, contextRevision});
    if (revision !== contextRevision) throw Object.assign(new Error("Connection changed."),{code:"CONTEXT_CHANGED"});
    return response;
  } });
})();
