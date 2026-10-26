"use strict";

(() => {
  const STORAGE_KEY = "we-ago:language";
  const supported = Object.freeze(["en", "es"]);
  const listeners = new Set();
  let language = "en", revision = 0;
  const normalize = value => supported.includes(value) ? value : "en";
  function t(source = "", ...values) {
    const key = typeof source === "string" ? source
      : source.reduce((text, part, i) => text + part + (i < values.length ? `{${i}}` : ""), "");
    const translated = language === "es" && Object.hasOwn(globalThis.__weAgoSpanish, key)
      ? globalThis.__weAgoSpanish[key] : key;
    // One pass: interpolated names, API values and markup are never translated or evaluated.
    return translated.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index]) : match);
  }
  function setLanguage(value) {
    revision++;
    const next = normalize(value);
    if (language === next) return;
    language = next;
    for (const listener of listeners) listener(language);
  }
  // Explicitly marked popup leaves only. Never traverse or rewrite native game nodes.
  function localize(root) {
    for (const node of root.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
    for (const attr of ["title", "placeholder", "aria-label"]) {
      for (const node of root.querySelectorAll(`[data-i18n-${attr}]`)) {
        node.setAttribute(attr, t(node.getAttribute(`data-i18n-${attr}`)));
      }
    }
    if (root.documentElement) root.documentElement.lang = language;
  }
  // Local storage is restricted to trusted extension contexts. Content scripts
  // receive this nonsecret preference through the worker, never the token store.
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id === chrome.runtime.id && message?.type === "WE_AGO_LANGUAGE_CHANGED") setLanguage(message.language);
  });
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && Object.hasOwn(changes, STORAGE_KEY)) setLanguage(changes[STORAGE_KEY].newValue);
  });
  const initialRevision = revision;
  const ready = chrome.runtime.sendMessage({ type: "WE_AGO_LANGUAGE_GET" }).then(response => {
    if (response?.ok && revision === initialRevision) setLanguage(response.data.language);
  }).catch(() => {});
  globalThis.__weAgoI18n = Object.freeze({
    t, normalize, supported, localize, setLanguage, ready,
    get language() { return language; },
    get locale() { return language === "es" ? "es-ES" : "en-US"; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  });
})();
