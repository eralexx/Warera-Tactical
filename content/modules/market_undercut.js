"use strict";

(() => {
  const t = (source = "", ...values) => globalThis.__weAgoI18n?.t(source, ...values)
    ?? (typeof source === "string" ? source : source.reduce((text, part, i) => text + part + (i < values.length ? values[i] : ""), ""));

  const unwrap = value => value && Object.hasOwn(value, "json") ? value.json : value;
  const positive = value => typeof value === "number" && Number.isFinite(value) && value > 0;
  const decimal = value => /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(String(value).trim()) ? Number(value) : NaN;
  const precision = value => {
    const [coefficient, exponent = "0"] = String(value).toLowerCase().split("e");
    return Math.max(0, (coefficient.split(".")[1]?.length || 0) - Number(exponent));
  };
  const fmt = value => Number.isFinite(value) ? value.toLocaleString(globalThis.__weAgoI18n?.locale || "en-US", { maximumFractionDigits: 8 }) : "—";
  function owned(tag, name, text) {
    const node = document.createElement(tag);
    node.className = "we-ago-undercut-" + name;
    node.dataset.weAgo = "true";
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Match only the supplied market-order dialog structure, never arbitrary price inputs.
  function identify(form) {
    const panel = form.closest('[id^="headlessui-dialog-panel-"]');
    const title = panel?.querySelector('[id^="headlessui-dialog-title-"]')?.textContent.trim();
    const mode = title ? "order" : null; // Structural order fields below, independent of native language.
    const price = form.querySelector('input[name="price"]');
    const quantity = form.querySelector('input[name="quantity"]');
    const image = form.querySelector('img[src*="/images/itemsv2/"]');
    const code = image?.getAttribute("alt");
    const label = price?.closest("label");
    if (!mode || !price || !quantity || !label || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(code || "")
      || !image.getAttribute("src").includes(`/images/itemsv2/${code}.png`)
      || !price.getClientRects().length || !quantity.getClientRects().length) return null;
    return { panel, mode, price, quantity, code, label };
  }

  function create() {
    const entries = new Map();
    const cache = new Map();
    let stopped = false;

    function mount(form, info) {
      const root = owned("div", "bar");
      const buttons = owned("div", "buttons");
      const entry = { ...info, form, root, actions: [] };
      for (const [kind, text] of [["undercut", t("Copy undercut")], ["ask", t("Copy ask")], ["bid", t("Copy bid")]]) {
        const button = owned("button", "button", text);
        button.type = "button";
        button.disabled = true;
        button.addEventListener("click", async event => {
          event.preventDefault();
          event.stopPropagation();
          // A real user activation copies a quote; native fields/events are untouched.
          if (!event.isTrusted || stopped || entries.get(form) !== entry) return;
          const current = identify(form);
          if (!current || current.price !== entry.price || current.code !== entry.code || current.mode !== entry.mode
            || entry.price.disabled || entry.price.readOnly) return;
          const value = candidate(entry, kind);
          if (!positive(value)) return;
          try {
            await navigator.clipboard.writeText(String(value));
            if (!stopped && entries.get(form) === entry) entry.status.textContent = t("Copied.");
          } catch {
            if (!stopped && entries.get(form) === entry) entry.status.textContent = t("Copy unavailable. Select the displayed price.");
          }
        });
        entry.actions.push({ button, kind });
        buttons.append(button);
      }
      const update = () => render(entry);
      form.addEventListener("input", update);
      form.addEventListener("change", update);
      entry.dispose = () => {
        form.removeEventListener("input", update);
        form.removeEventListener("change", update);
        root.remove();
      };
      entry.status = owned("p", "status"); entry.status.setAttribute("role", "status");
      root.append(buttons, entry.status);
      // Outside the native label so helper controls cannot activate the price label.
      info.label.after(root);
      return entry;
    }

    function candidate(entry, kind) {
      const snapshot = cache.get(entry.code);
      if (!snapshot) return NaN;
      if (kind !== "undercut") return snapshot[kind];
      const nativeStep = decimal(entry.price.getAttribute("step"));
      // The supplied text input uses step="any". Default to a 0.001 quote
      // increment, retaining finer precision when the current ask requires it.
      const placesQuoted = Math.max(3, precision(snapshot.ask));
      const tick = positive(nativeStep) ? nativeStep : 10 ** -placesQuoted;
      if (!positive(tick) || !positive(snapshot.ask)) return NaN;
      // Decimal rounding avoids results such as 0.106 - 0.001 = 0.10499999…
      const places = Math.max(precision(tick), precision(snapshot.ask));
      return places <= 8 ? Number((snapshot.ask - tick).toFixed(places)) : NaN;
    }

    function render(entry) {
      if (stopped || !entry.root.isConnected) return;
      for (const { button, kind } of entry.actions) {
        const value = candidate(entry, kind);
        button.disabled = entry.price.disabled || entry.price.readOnly || !positive(value);
        const text = kind === "undercut" ? t("Copy undercut") : kind === "ask" ? t("Copy ask") : t("Copy bid");
        if (positive(value)) globalThis.__weAgoUi.money(button, text + " · " + fmt(value));
        else { delete button.dataset.money; setText(button, text); }
      }
      const snapshot = cache.get(entry.code);
      setText(entry.status, !snapshot || snapshot.pending ? t("Loading prices…") : snapshot.error || (snapshot.expiresAt <= Date.now()
        ? t("Last known prices · refreshing…") : !positive(snapshot.ask) && !positive(snapshot.bid) ? t("No active buy or sell orders.")
          : !positive(snapshot.ask) ? t("No active sell orders.") : !positive(snapshot.bid) ? t("No active buy orders.") : ""));
    }

    function setText(node, text) { if (node.textContent !== text) node.textContent = text; }

    async function load(code) {
      const previous = cache.get(code);
      if (previous?.pending || previous?.expiresAt > Date.now() || previous?.retryAt > Date.now()) return;
      const snapshot = { ...previous, error: "", pending: true };
      cache.set(code, snapshot);
      for (const entry of entries.values()) if (entry.code === code) render(entry);
      try {
        const response = await (globalThis.__weAgoApi?.send ?? chrome.runtime.sendMessage)({ type: "WE_AGO_QUERY", procedure: "tradingOrder.getTopOrders",
          input: { itemCode: code, limit: 10 }, options: { ttlSeconds: 120 } });
        if (stopped) return;
        if (!response?.ok) throw Object.assign(new Error("Market unavailable"), response?.error);
        const ordersResult = response.data;
        const orders = unwrap(ordersResult?.data);
        if (!Array.isArray(orders?.buyOrders) || !Array.isArray(orders?.sellOrders)) throw new Error("Unexpected book");
        const values = side => orders[side].filter(order => order.itemCode === code && positive(order.price) && positive(order.quantity)).map(order => order.price);
        const buys = values("buyOrders"), sells = values("sellOrders");
        const expiresAt = Math.min(ordersResult.expiresAt, ordersResult.createdAt + 120000);
        if (!Number.isFinite(expiresAt)) throw new Error("Missing cache metadata");
        Object.assign(snapshot, { bid: buys.length ? Math.max(...buys) : NaN, ask: sells.length ? Math.min(...sells) : NaN,
          expiresAt });
      } catch (error) {
        Object.assign(snapshot, { error: globalThis.__weAgoUi.readError(error, t("Prices")), retryAt: Date.now() + 30000 });
      } finally {
        snapshot.pending = false;
        if (!stopped) for (const entry of entries.values()) if (entry.code === code) render(entry);
      }
    }

    function sync({ discover = true } = {}) {
      if (stopped) return;
      const active = /^\/market(?:\/|$)/.test(location.pathname);
      for (const [form, entry] of entries) {
        const current = active && form.isConnected && (discover ? identify(form) : entry);
        if (!current || current.price !== entry.price || current.quantity !== entry.quantity || current.code !== entry.code
          || current.mode !== entry.mode || !entry.root.isConnected) {
          entry.dispose(); entries.delete(form);
        }
      }
      if (!active || document.hidden) return;
      if (!discover) {
        for (const entry of entries.values()) { render(entry); void load(entry.code); }
        return;
      }
      for (const form of document.querySelectorAll('form:has(input[name="price"]):has(input[name="quantity"])')) {
        const info = identify(form);
        if (!info) continue;
        if (!entries.has(form)) entries.set(form, mount(form, info));
        render(entries.get(form));
        void load(info.code);
      }
    }
    return { sync, tick() { sync({ discover: false }); }, destroy() { stopped = true; for (const entry of entries.values()) entry.dispose(); entries.clear(); cache.clear(); } };
  }
  globalThis.__weAgoUndercut = { create };
})();
