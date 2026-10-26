"use strict";

(() => {
  const t = (source = "", ...values) => globalThis.__weAgoI18n?.t(source, ...values)
    ?? (typeof source === "string" ? source : source.reduce((text, part, i) => text + part + (i < values.length ? values[i] : ""), ""));

  const owned = (tag, svg = false) => {
    const node = svg ? document.createElementNS("http://www.w3.org/2000/svg", tag) : document.createElement(tag);
    node.setAttribute("class", "we-ago-" + (svg ? "gold-icon" : "money-value"));
    node.dataset.weAgo = "true";
    return node;
  };
  // Coin path from the native game markup retained in the MU fixture.
  function gold() {
    const icon = owned("svg", true), path = owned("path", true);
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("role", "img"); icon.setAttribute("aria-label", t("Gold"));
    icon.setAttribute("focusable", "false");
    path.setAttribute("d", "M12 5C7.031 5 2 6.546 2 9.5S7.031 14 12 14c4.97 0 10-1.546 10-4.5S16.97 5 12 5zm-5 9.938v3c1.237.299 2.605.482 4 .541v-3a21.166 21.166 0 0 1-4-.541zm6 .54v3a20.994 20.994 0 0 0 4-.541v-3a20.994 20.994 0 0 1-4 .541zm6-1.181v3c1.801-.755 3-1.857 3-3.297v-3c0 1.44-1.199 2.542-3 3.297zm-14 3v-3C3.2 13.542 2 12.439 2 11v3c0 1.439 1.2 2.542 3 3.297z");
    icon.append(path); return icon;
  }
  function money(host, value, suffix = "") {
    const key = String(value) + "\u0000" + suffix;
    if (host.dataset.money === key) return;
    const text = owned("span"); text.textContent = String(value) + " ";
    host.replaceChildren(text, gold(), document.createTextNode(suffix));
    host.dataset.money = key;
  }
  function readError(error, scope) {
    const code = String(error?.code || ""), status = Number(error?.status ?? error?.httpStatus);
    if (code === "TOKEN_MISSING") return t("Save an API token in Settings → API connection.");
    if (code === "PLAYER_SETUP") return t("Set API token and player ID in Settings → API connection.");
    if (code === "INVALID_TOKEN") return t("Check API token in Settings → API connection.");
    if (status === 401) return scope + t(": API authorization rejected (401).");
    if (status === 429 || /RATE_LIMIT/.test(code)) return scope + t(" rate limited · retrying.");
    if (status === 403 || code === "FORBIDDEN") return scope + t(" access denied · check API connection.");
    return scope + t(" unavailable · retrying.");
  }
  // Reuse existing owned DOM, preserving listeners, focus and scroll on refresh.
  function patch(target, source) {
    if (target.nodeType === 3) { if (target.data !== source.data) target.data = source.data; return; }
    for (const attr of [...target.attributes]) if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name);
    for (const attr of [...source.attributes]) if (target.getAttribute(attr.name) !== attr.value) target.setAttribute(attr.name, attr.value);
    const old = [...target.childNodes], next = [...source.childNodes];
    next.forEach((child, index) => {
      if (old[index]?.nodeType === child.nodeType && old[index]?.nodeName === child.nodeName) patch(old[index], child);
      else if (old[index]) target.replaceChild(child, old[index]);
      else target.append(child);
    });
    old.slice(next.length).forEach(child => child.remove());
  }
  function reconcile(list, nodes) {
    const previous = new Map([...list.children].map(node => [node.dataset.rowKey, node]));
    const focused = list.contains(document.activeElement), oldFocus = document.activeElement;
    const result = nodes.map((node, index) => {
      const existing = previous.get(node.dataset.rowKey);
      if (existing?.tagName === node.tagName) { patch(existing, node); node = existing; }
      previous.delete(node.dataset.rowKey);
      if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
      return node;
    });
    for (const node of previous.values()) node.remove();
    if (focused && !oldFocus.isConnected) (result[0]?.querySelector("a, button") || result[0])?.focus?.();
    return result;
  }
  globalThis.__weAgoUi = { gold, money, readError, reconcile };
})();
