"use strict";

(() => {
  const t = (source = "", ...values) => globalThis.__weAgoI18n?.t(source, ...values)
    ?? (typeof source === "string" ? source : source.reduce((text, part, i) => text + part + (i < values.length ? values[i] : ""), ""));

  const TTL_SECONDS = 120;
  const SELECTOR = '[id^="item-code-selector-"]';
  const PREFIX = "item-code-selector-";
  const number = value => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  const unwrap = value => value && Object.hasOwn(value, "json") ? value.json : value;
  const format = value => value === null ? "—" : value.toLocaleString(globalThis.__weAgoI18n?.locale || "en-US", { maximumFractionDigits: 6 });
  const percent = value => value === null ? "—" : `${value.toFixed(1)}%`;
  const signed = value => value === null ? "—" : `${value < 0 ? "−" : "+"}${Math.abs(value).toFixed(1)}%`;
  const compactPercent = value => value === null ? "—"
    : `${value < 0 ? "−" : ""}${Math.abs(value).toFixed(Math.abs(value) < 10 ? 1 : 0).replace(/\.0$/, "")}%`;

  function metrics(code, average, orders) {
    const side = name => Array.isArray(orders?.[name]) ? orders[name]
      .filter(order => order?.itemCode === code && number(order.quantity) !== null && number(order.price) !== null) : [];
    const buys = side("buyOrders");
    const sells = side("sellOrders");
    const bid = buys.length ? Math.max(...buys.map(order => order.price)) : null;
    const ask = sells.length ? Math.min(...sells.map(order => order.price)) : null;
    const quantity = (book, price) => {
      const sum = book.filter(order => order.price === price).reduce((total, order) => total + order.quantity, 0);
      return price === null || !Number.isFinite(sum) ? null : sum;
    };
    return {
      bid, ask, average,
      bidQuantity: quantity(buys, bid), askQuantity: quantity(sells, ask),
      buyCount: buys.length, sellCount: sells.length,
      spread: bid !== null && ask !== null ? (ask - bid) / bid * 100 : null,
      delta: ask !== null && average !== null ? (ask - average) / average * 100 : null,
      bargain: ask !== null && average !== null && ask < average
    };
  }

  function snapshot(result, orderBook = false) {
    const data = unwrap(result?.data);
    if (!Number.isFinite(result?.expiresAt) || !data || typeof data !== "object"
      || Array.isArray(data) || (orderBook && (!Array.isArray(data.buyOrders) || !Array.isArray(data.sellOrders)))) {
      throw new Error("Unexpected market response shape.");
    }
    return { data, expiresAt: result.expiresAt, createdAt: result.createdAt };
  }

  function create() {
    const tiles = new Map();
    let candidates = [];
    const orders = new Map();
    let prices;
    let pending = false;
    let stopped = false;
    let retryAt = 0;
    let route = location.href;
    let generation = 0;
    let lastError = false;
    let fontSize = 11;
    let displayRevision = 0;
    const fontLayouts = new WeakMap();
    const calloutModels = new WeakMap();
    let callout;
    let calloutFields;
    let activeBadge;
    let hideTimer;

    function owned(tag, name, text) {
      const node = document.createElement(tag);
      node.className = "we-ago-market-" + name;
      node.dataset.weAgo = "true";
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function hideCallout() {
      clearTimeout(hideTimer);
      activeBadge?.removeAttribute("aria-describedby");
      activeBadge = undefined;
      if (callout) callout.hidden = true;
    }

    function delayHide() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hideCallout, 140);
    }

    function ensureCallout() {
      if (callout) return;
      callout = owned("div", "callout");
      callout.id = "we-ago-market-callout";
      callout.setAttribute("role", "tooltip");
      callout.style.setProperty("position", "fixed", "important");
      callout.hidden = true;
      const heading = owned("div", "callout-heading");
      const name = owned("strong", "callout-name");
      heading.append(name);
      const hero = owned("div", "callout-hero");
      hero.append(owned("span", "callout-label", t("BID / ASK SPREAD")));
      const spread = owned("strong", "callout-spread");
      const spreadValue = owned("span", "callout-spread-value");
      hero.append(spread, spreadValue);
      const grid = owned("dl", "callout-grid");
      const values = {};
      for (const [key, label] of [["bid", t("Best buy bid")], ["ask", t("Lowest sell ask")], ["average", t("Price benchmark")], ["delta", t("Ask vs benchmark")]]) {
        const cell = owned("div", "callout-cell");
        values[key] = owned("dd", "callout-value");
        cell.append(owned("dt", "callout-label", label), values[key]);
        grid.append(cell);
      }
      const comparison = owned("p", "callout-comparison");
      const depth = owned("p", "callout-depth");
      const age = owned("p", "callout-age");
      const state = owned("p", "callout-state");
      callout.append(heading, hero, grid, comparison, depth, age, state,
        owned("p", "callout-note", t("Spread = (ask − bid) / bid. Prices per unit, before fees; orders can change.")));
      calloutFields = { name, spread, spreadValue, ...values, comparison, depth, age, state };
      callout.addEventListener("pointerenter", () => clearTimeout(hideTimer));
      callout.addEventListener("pointerleave", delayHide);
      document.body.append(callout);
    }

    function positionCallout() {
      if (!activeBadge?.isConnected || !callout || callout.hidden) return;
      const rect = activeBadge.getBoundingClientRect();
      const box = callout.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const height = document.documentElement.clientHeight;
      let left = rect.right + 10;
      if (left + box.width > width - 12) left = rect.left - box.width - 10;
      left = Math.max(12, Math.min(left, width - box.width - 12));
      const top = Math.max(12, Math.min(rect.top, height - box.height - 12));
      callout.style.left = `${left}px`;
      callout.style.top = `${top}px`;
    }

    function updateCallout() {
      const model = calloutModels.get(activeBadge);
      if (!model || !callout) return;
      const { code, values, state, priceTime, orderTime, hasBook } = model;
      const write = (node, text) => { delete node.dataset.money; if (node.textContent !== text) node.textContent = text; };
      write(calloutFields.name, code.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, c => c.toUpperCase()));
      write(calloutFields.spread, percent(values.spread));
      if (values.ask !== null && values.bid !== null) globalThis.__weAgoUi.money(calloutFields.spreadValue, format(values.ask - values.bid), t(" / unit"));
      else write(calloutFields.spreadValue, t("Both sides of the book are needed"));
      globalThis.__weAgoUi.money(calloutFields.bid, format(values.bid));
      globalThis.__weAgoUi.money(calloutFields.ask, format(values.ask));
      globalThis.__weAgoUi.money(calloutFields.average, format(values.average));
      write(calloutFields.delta, signed(values.delta));
      if (values.delta === null) write(calloutFields.comparison, t("No sell-to-benchmark comparison available."));
      else if (values.ask === values.average) write(calloutFields.comparison, t("Lowest sell matches the benchmark."));
      else globalThis.__weAgoUi.money(calloutFields.comparison, format(Math.abs(values.ask - values.average)), t` / unit ${values.bargain ? t("below") : t("above")} benchmark`);
      write(calloutFields.depth, hasBook ? t`At best bid: ${format(values.bidQuantity)} units · at best ask: ${format(values.askQuantity)} units` : t("Order depth unavailable."));
      const age = time => Number.isFinite(time) ? `${Math.max(0, Math.floor((Date.now() - time) / 1000))}s` : t("unknown");
      write(calloutFields.age, t`Price age: ${age(priceTime)} · order age: ${age(orderTime)}`);
      write(calloutFields.state, state);
      callout.dataset.bargain = values.bargain && !lastError ? "true" : "false";
      positionCallout();
    }

    function showCallout(badge) {
      if (stopped || !badge.isConnected || !calloutModels.has(badge)) return;
      clearTimeout(hideTimer);
      activeBadge?.removeAttribute("aria-describedby");
      activeBadge = badge;
      ensureCallout();
      if (callout.parentNode !== document.body) document.body.append(callout);
      badge.setAttribute("aria-describedby", callout.id);
      callout.hidden = false;
      updateCallout();
    }

    const onScroll = event => {
      if (event.target === callout || (event.target?.nodeType && callout?.contains(event.target))) return;
      hideCallout();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", hideCallout);

    function applyDisplay(display) {
      const size = display?.marketFontSize;
      if (Number.isInteger(size) && size >= 7 && size <= 14) {
        fontSize = size;
        for (const badge of tiles.values()) fitFont(badge);
      }
    }

    function fitFont(badge) {
      const width = badge.clientWidth;
      const signature = `${fontSize}:${width}:${badge.textContent}`;
      if (fontLayouts.get(badge) === signature) return;
      badge.style.fontSize = `${fontSize}px`;
      // Keep larger type from clipping exceptionally long percentages. Only
      // measure our own badge; no native dimensions or text are changed.
      let fitted = fontSize;
      if (width > 0 && badge.scrollWidth > width && fontSize > 7) {
        // Search the same half-pixel sizes with at most four probes instead
        // of forcing layout once for every step from 14px down to 7px.
        let low = 0, high = (fontSize - 7) * 2 - 1, best = 0;
        while (low <= high) {
          const step = Math.floor((low + high) / 2);
          badge.style.fontSize = `${7 + step / 2}px`;
          if (badge.scrollWidth <= width) { best = step; low = step + 1; }
          else high = step - 1;
        }
        fitted = 7 + best / 2;
        badge.style.fontSize = `${fitted}px`;
      }
      if (width > 0) fontLayouts.set(badge, signature);
    }

    const onDisplayMessage = (message, sender) => {
      if (!stopped && sender.id === chrome.runtime.id && message?.type === "WE_AGO_DISPLAY_CHANGED") {
        displayRevision++;
        applyDisplay(message.display);
      }
    };
    chrome.runtime.onMessage.addListener(onDisplayMessage);
    const initialDisplayRevision = displayRevision;
    void send("WE_AGO_DISPLAY_GET", {}).then(display => {
      if (!stopped && displayRevision === initialDisplayRevision) applyDisplay(display);
    }).catch(() => { /* Use the larger default if preferences cannot be read. */ });

    function clearTiles() {
      hideCallout();
      for (const badge of tiles.values()) badge.remove();
      tiles.clear();
    }

    function onMarket() {
      return location.pathname === "/market" || location.pathname.startsWith("/market/");
    }

    async function send(type, fields) {
      const response = await (globalThis.__weAgoApi?.send ?? chrome.runtime.sendMessage)({ type, ...fields });
      if (!response?.ok) throw new Error(t("Market data unavailable. Check Settings → API connection."));
      return response.data;
    }

    function averageFor(code) {
      const value = prices?.data?.[code];
      return number(value) ?? number(value?.averagePrice) ?? number(value?.price);
    }

    function render(tile, badge, now, measure = true) {
      const code = tile.id.slice(PREFIX.length);
      const record = orders.get(code);
      const validPrices = Boolean(prices);
      const validOrders = Boolean(record);
      const average = validPrices ? averageFor(code) : null;
      const values = metrics(code, average, validOrders ? record.data : null);
      const deltaLabel = values.delta === null ? "—" : `${values.delta < 0 ? "−" : "+"}${compactPercent(Math.abs(values.delta))}`;
      const content = `S${compactPercent(values.spread)}\nΔ${deltaLabel}`;
      let title;
      if (lastError) title = t("Market data unavailable. Check Settings → API connection.");
      else if (!validPrices) title = t("Market data loading or expired. Awaiting a fresh response.");
      else if (average === null) title = t`No API price benchmark for ${code}.`;
      else if (!validOrders) title = t`Order data loading or expired for ${code}.`;
      else title = values.ask === null ? t("No valid sell orders returned.") : values.bid === null ? t("No valid buy orders returned.")
        : values.bargain ? t("Lowest sell is below the price benchmark.") : t("Lowest sell is at or above the price benchmark.");
      // Update owned nodes only, and only when something changed.
      const changed = badge.textContent !== content;
      if (changed) badge.textContent = content;
      if (measure || changed) fitFont(badge);
      if (prices && prices.expiresAt <= now || record && record.expiresAt <= now) title = t("Last known · ") + title;
      const calloutValues = values;
      badge.setAttribute("aria-label", t`${code}: spread ${percent(calloutValues.spread)}; ask vs benchmark ${signed(calloutValues.delta)}. Focus for market details.`);
      calloutModels.set(badge, { code, values: calloutValues, state: title, priceTime: prices?.createdAt, orderTime: record?.createdAt, hasBook: validOrders });
      if (activeBadge === badge) updateCallout();
      const bargain = validPrices && validOrders && values.bargain ? "true" : "false";
      if (badge.dataset.bargain !== bargain) badge.dataset.bargain = bargain;
    }

    async function load(codes) {
      pending = true;
      const currentGeneration = generation;
      const alive = () => !stopped && generation === currentGeneration && route === location.href && !document.hidden;
      try {
        if (!prices || prices.expiresAt <= Date.now()) {
          const result = await send("WE_AGO_QUERY", {
            procedure: "itemTrading.getPrices", input: {}, options: { ttlSeconds: TTL_SECONDS }
          });
          if (!alive()) return;
          prices = snapshot(result);
        }
        const needed = codes.filter(code => averageFor(code) !== null
          && (!orders.has(code) || orders.get(code).expiresAt <= Date.now()));
        // The background client accepts at most 20 calls per batch.
        for (let offset = 0; offset < needed.length; offset += 20) {
          if (!alive()) return;
          const group = needed.slice(offset, offset + 20);
          const results = await send("WE_AGO_BATCH", { calls: group.map(itemCode => ({
            procedure: "tradingOrder.getTopOrders", input: { itemCode, limit: 10 }, ttlSeconds: TTL_SECONDS
          })) });
          if (!alive()) return;
          for (const [index, code] of group.entries()) {
            const result = results[index];
            orders.set(code, snapshot(result, true));
          }
        }
        lastError = false;
        retryAt = 0;
      } catch {
        if (!alive()) return;
        lastError = true;
        retryAt = Date.now() + 30000;
      } finally {
        pending = false;
        if (!stopped) sync();
      }
    }

    function sync({ discover = true } = {}) {
      if (stopped) return;
      if (route !== location.href) {
        route = location.href;
        generation++;
        candidates = [];
        discover = true;
        clearTiles();
        orders.clear();
        prices = undefined;
        lastError = false;
        retryAt = 0;
      }
      if (!onMarket()) { clearTiles(); return; }
      if (document.hidden) return;
      for (const [tile, badge] of tiles) {
        if (!tile.isConnected || badge.parentNode !== tile) {
          badge.remove();
          tiles.delete(tile);
        }
      }
      const codes = new Set();
      const activeTiles = new Set();
      const now = Date.now();
      // Read candidate geometry together before inserting/updating badges.
      if (discover) candidates = [...document.querySelectorAll(SELECTOR)].filter(tile => {
        const code = tile.id.slice(PREFIX.length);
        return /^[a-zA-Z][a-zA-Z0-9]*$/.test(code)
          && tile.querySelector("img")?.getAttribute("alt") === code
          && tile.parentElement?.getAttribute("aria-haspopup") === "dialog"
          && tile.getClientRects().length > 0;
      });
      for (const tile of candidates) {
        if (!tile.isConnected) continue;
        const code = tile.id.slice(PREFIX.length);
        let badge = tiles.get(tile);
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "we-ago-market-badge";
          badge.dataset.weAgo = "true";
          badge.dataset.bargain = "false";
          // Add a positioning anchor only to originally static tiles. Keep
          // native relative/absolute/fixed/sticky positioning intact.
          badge.dataset.anchor = getComputedStyle(tile).position === "static" ? "static" : "positioned";
          badge.tabIndex = 0;
          badge.setAttribute("role", "button");
          badge.setAttribute("aria-label", t`Market details: ${code}`);
          badge.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); showCallout(badge); });
          badge.addEventListener("pointerenter", () => showCallout(badge));
          badge.addEventListener("pointerleave", delayHide);
          badge.addEventListener("focus", () => showCallout(badge));
          badge.addEventListener("blur", delayHide);
          badge.addEventListener("keydown", event => {
            if (event.key === "Escape") { event.stopPropagation(); hideCallout(); }
            else if (["Enter", " "].includes(event.key)) { event.preventDefault(); event.stopPropagation(); showCallout(badge); }
          });
          tile.append(badge);
          tiles.set(tile, badge);
        }
        codes.add(code);
        activeTiles.add(tile);
        render(tile, badge, now, discover);
      }
      // Do not leave an old green marker behind on hidden/recycled tiles.
      for (const [tile, badge] of tiles) {
        if (!activeTiles.has(tile)) {
          badge.remove();
          tiles.delete(tile);
        }
      }
      if (activeBadge && (!activeBadge.isConnected || ![...tiles.values()].includes(activeBadge))) hideCallout();
      if (!codes.size || pending || now < retryAt) return;
      const needsPrices = !prices || prices.expiresAt <= now;
      const needsOrders = [...codes].some(code => averageFor(code) !== null
        && (!orders.has(code) || orders.get(code).expiresAt <= now));
      if (needsPrices || needsOrders) void load([...codes]);
    }

    return {
      sync,
      tick() { sync({ discover: false }); },
      destroy() {
        stopped = true;
        chrome.runtime.onMessage.removeListener(onDisplayMessage);
        window.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("resize", hideCallout);
        generation++;
        clearTiles();
        candidates = [];
        callout?.remove();
        orders.clear();
        prices = undefined;
      }
    };
  }

  globalThis.__weAgoMarket = { create };
})();
