"use strict";

(() => {
  const t = (source = "", ...values) => globalThis.__weAgoI18n?.t(source, ...values)
    ?? (typeof source === "string" ? source : source.reduce((text, part, i) => text + part + (i < values.length ? values[i] : ""), ""));

  const unwrap = value => value && Object.hasOwn(value, "json") ? value.json : value;
  const valid = value => typeof value === "number" && Number.isFinite(value);
  const positive = value => valid(value) && value > 0;
  const id = value => typeof value === "string" ? value : value?._id;
  const format = (value, decimals = 2) => valid(value) ? value.toLocaleString(globalThis.__weAgoI18n?.locale || "en-US", {
    minimumFractionDigits: decimals === 3 ? 3 : 0, maximumFractionDigits: decimals
  }) : "—";
  const onRoute = () => /^\/companies\/?$/.test(location.pathname);

  // Prices value both purchased and already-owned inputs at replacement cost.
  function economics(company, config, prices, productionBonus) {
    const recipe = config?.items?.[company.itemCode];
    // Same authoritative total used by the game's pickaxe badge and AE regen.
    // A missing response is unknown, never a deposit-only or zero estimate.
    const bonus = productionBonus?.total;
    if (!recipe || !valid(bonus) || bonus < -100 || !positive(recipe.productionPoints) || !positive(prices?.[company.itemCode])) return null;
    let inputs = 0;
    for (const [code, quantity] of Object.entries(recipe.productionNeeds ?? {})) {
      if (!valid(quantity) || quantity < 0 || !positive(prices[code])) return null;
      inputs += quantity * prices[code];
    }
    const perPP = (prices[company.itemCode] - inputs) / recipe.productionPoints * (1 + bonus / 100);
    if (!valid(perPP)) return null;
    const level = company.activeUpgradeLevels?.automatedEngine;
    const dailyPP = config?.upgradesConfig?.automatedEngine?.levels?.[level]?.stats?.dailyProd;
    return { perPP, daily: valid(dailyPP) && dailyPP >= 0 ? perPP * dailyPP : null, level, bonus };
  }

  function advise(companies, upgrades, config, prices, models, capacity) {
    const levels = config?.upgradesConfig?.automatedEngine?.levels;
    if (!levels || companies.some(company => !Number.isInteger(company.activeUpgradeLevels?.automatedEngine))) {
      return null;
    }
    const minimum = Math.min(...companies.map(company => company.activeUpgradeLevels.automatedEngine));
    const candidates = [];
    let incomplete = false;
    const add = (companyId, label, cost, income) => {
      if (!valid(cost) || cost < 0 || !valid(income)) { incomplete = true; return; }
      if (income > 0 && Number.isFinite(cost / income)) candidates.push({ companyId, label, cost, days: cost / income });
    };
    for (const company of companies) {
      const current = company.activeUpgradeLevels.automatedEngine;
      if (current !== minimum || !levels[current + 1]) continue;
      const upgrade = upgrades.get(company._id);
      if (!upgrade || upgrade.company !== company._id || upgrade.upgradeType !== "automatedEngine") { incomplete = true; continue; }
      // A pending/different purchased level is not an immediately available step.
      if (upgrade.level !== current || (upgrade.willBeActiveAt && Date.parse(upgrade.willBeActiveAt) > Date.now())) continue;
      const next = levels[current + 1];
      const delta = next.stats?.dailyProd - levels[current]?.stats?.dailyProd;
      if (!positive(prices.steel) || !valid(next.steelCost) || next.steelCost < 0 || delta !== 24 || !models.get(company._id)) { incomplete = true; continue; }
      add(company._id, t`Upgrade AE to Lv ${current + 1}`, next.steelCost * prices.steel,
        delta * models.get(company._id).perPP);
    }
    if (!Number.isInteger(capacity) || capacity < 0) incomplete = true;
    else if (companies.length < capacity) {
      const concrete = config?.company?.constructionCostIncreasePerCompany;
      for (const company of companies) {
        const model = models.get(company._id);
        if (!model || !positive(prices.concrete) || !positive(concrete) || !positive(levels[1]?.stats?.dailyProd)) {
          incomplete = true; continue;
        }
        add(company._id, t`New ${company.itemCode} factory · same region`, (companies.length + 1) * concrete * prices.concrete,
          levels[1].stats.dailyProd * model.perPP);
      }
    }
    if (incomplete) return null;
    candidates.sort((a, b) => a.days - b.days || a.cost - b.cost || a.companyId.localeCompare(b.companyId));
    const best = candidates[0];
    return best ? { companyId: best.companyId, cost: best.cost, days: best.days, label: best.label, text: t`Next: ${best.label}\n${format(best.cost)} gold · ${format(best.days)} d payback` }
      : null;
  }

  function owned(name, text, tag = "div") {
    const node = document.createElement(tag);
    node.className = "we-ago-company-" + name;
    node.dataset.weAgo = "true";
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function metric(name, label, value, suffix = "") {
    const node = owned(name);
    const amount = owned("value", undefined, "span");
    if (value === t("Unprofitable")) amount.textContent = value;
    else globalThis.__weAgoUi.money(amount, value, suffix);
    node.append(owned("label", label, "span"), amount);
    return node;
  }

  function create() {
    const cards = new Map();
    let stopped = false, pending = false, generation = 0, route = location.href;
    let snapshot, fallback, fallbackBody, retryAt = 0;
    let fallbackOpen = false;
    let errorText = "";
    const placements = new Map();
    const active = () => !stopped && onRoute() && !document.hidden;
    const clear = () => {
      for (const card of cards.values()) card.remove();
      cards.clear(); placements.clear();
      if (fallback) fallbackOpen = fallback.open;
      fallback?.remove(); fallback = fallbackBody = undefined;
    };
    function ensureFallback() {
      if (!document.body) return null;
      if (!fallback?.isConnected) {
        fallback?.remove();
        fallback = owned("fallback", undefined, "details");
        fallback.setAttribute("name", "we-ago-floating");
        fallback.open = fallbackOpen;
        fallback.append(owned("toggle", t("Company advisor"), "summary"));
        fallbackBody = owned("fallback-body");
        fallback.append(fallbackBody);
        // Stay out of native flex/grid sizing, even before CSS has loaded.
        fallback.style.setProperty("position", "fixed", "important");
        document.body.append(fallback);
      }
      return fallbackBody;
    }
    async function message(request) {
      const response = await (globalThis.__weAgoApi?.send ?? chrome.runtime.sendMessage)(request);
      if (!response?.ok) {
        const code = response?.error?.code;
        throw new Error(code === "TOKEN_MISSING" ? t("Set API token in extension settings")
          : code === "INVALID_TOKEN" ? t("Check API token in extension settings")
            : t`Company data unavailable${code ? ` (${code})` : ""} · retrying`);
      }
      return response.data;
    }
    function mount(discover = true) {
      if (!snapshot) {
        const host = ensureFallback();
        const text = errorText || t("Loading…");
        if (host && host.textContent !== text) {
          host.textContent = text;
          host.setAttribute("role", "status");
        }
        return;
      }
      if (!discover && cards.size === snapshot.companies.length
        && (!fallback || fallback.isConnected)
        && [...cards].every(([key, card]) => card.isConnected && placements.get(key)?.isConnected)) return;
      const scope = document.getElementById?.("main-window") || document;
      const targets = new Map();
      const companyIds = new Set(snapshot.companies.map(company => company._id));
      for (const node of scope.querySelectorAll('[data-company-id], a[href]')) {
        if (node.closest('[data-we-ago="true"]')) continue;
        let companyId = node.getAttribute("data-company-id");
        if (!companyId && node.tagName === "A") {
          try {
            const url = new URL(node.getAttribute("href"), location.href);
            if (url.origin === location.origin) companyId = url.pathname.match(/^\/(?:company|companies)\/([a-f\d]{24})\/?$/i)?.[1];
          } catch { /* Ignore unrelated malformed links. */ }
        }
        if (companyIds.has(companyId) && !targets.has(companyId)) targets.set(companyId, node);
      }
      // Company titles may be plain text rather than links. Use only exact,
      // unique API names and unique native leaf elements; never use list order.
      const names = new Map();
      for (const company of snapshot.companies) {
        const name = company.name?.trim();
        if (name) names.set(name, (names.get(name) || 0) + 1);
      }
      const titleNodes = new Map();
      for (const node of scope.querySelectorAll('h1, h2, h3, h4, [role="heading"], span, p, div')) {
        if (node.childElementCount || node.closest('[data-we-ago="true"]')) continue;
        const name = node.textContent?.trim();
        if (names.get(name) !== 1) continue;
        const matches = titleNodes.get(name) || [];
        matches.push(node); titleNodes.set(name, matches);
      }
      for (const company of snapshot.companies) {
        const matches = titleNodes.get(company.name?.trim());
        if (!targets.has(company._id) && matches?.length === 1) {
          const title = matches[0];
          targets.set(company._id, title.closest('a, button, [role="button"]') || title);
        }
      }
      const unmatched = snapshot.companies.filter(company => !targets.has(company._id));
      if (unmatched.length || !snapshot.companies.length) {
        const host = ensureFallback();
        if (host) {
          // Only replace extension-owned loading/error text, never game text.
          if (!host.childElementCount) host.textContent = "";
          host.removeAttribute("role");
          if (!snapshot.companies.length && host.textContent !== t("No companies found")) host.textContent = t("No companies found");
          for (const company of unmatched) targets.set(company._id, host);
        }
      } else {
        if (fallback) fallbackOpen = fallback.open;
        fallback?.remove(); fallback = fallbackBody = undefined;
      }
      for (const [companyId, card] of cards) {
        if (!targets.has(companyId) || !card.isConnected || placements.get(companyId) !== targets.get(companyId)) {
          card.remove(); cards.delete(companyId); placements.delete(companyId);
        }
      }
      for (const [companyId, target] of targets) {
        if (cards.has(companyId)) continue;
        const card = owned("card");
        card.setAttribute("role", "group");
        card.setAttribute("aria-label", t("Company economics"));
        const company = snapshot.companies.find(value => value._id === companyId);
        if (target === fallbackBody) card.append(owned("name", company.name || company.itemCode));
        const model = snapshot.models.get(companyId);
        const daily = model?.daily;
        card.append(metric("profit", t("AE net/day"), format(daily, 3)));
        const wage = valid(model?.perPP) && model.perPP <= 0 ? t("Unprofitable") : format(model?.perPP, 3);
        card.append(metric("wage", t("Max wage"), wage, "/PP"));
        if (snapshot.advice?.companyId === companyId) {
          const advice = owned("advice"), cost = owned("advice-cost", undefined, "span");
          globalThis.__weAgoUi.money(cost, format(snapshot.advice.cost), t` · ${format(snapshot.advice.days)} d payback`);
          advice.append(owned("advice-label", t`Next: ${snapshot.advice.label}\n`, "span"), cost);
          card.append(advice);
        }
        card.dataset.loss = String(valid(daily) && daily < 0);
        card.title = t("24-hour production potential, valued at market prices after recipe inputs; before selling taxes, storage stops and worker fidelity. ")
          + (!model ? t("Profit data or total production bonus unavailable. ") : t("Uses the game's total company production bonus. "))
          + t("New factory comparison assumes AE1, the same output and region, and an available company slot. ")
          + (company.isFull ? t("Storage is full; actual production may stop.") : "");
        // Keep the summary outside native links/buttons; never rewrite game text.
        if (target === fallbackBody || (target.hasAttribute("data-company-id") && !target.matches('a, button, [role="button"]'))) target.append(card);
        else target.after(card);
        cards.set(companyId, card);
        placements.set(companyId, target);
      }
    }
    async function refresh() {
      if (!active() || pending || Date.now() < retryAt) return;
      pending = true;
      const version = generation;
      const alive = () => active() && version === generation && route === location.href;
      const expiries = [];
      const query = async (procedure, input = {}, ttlSeconds = 120) => {
        if (!alive()) throw new Error("Obsolete route");
        const result = await message({ type: "WE_AGO_QUERY", procedure, input, options: { ttlSeconds } });
        if (!valid(result.expiresAt)) throw new Error(t("Company data unavailable · retrying"));
        expiries.push(result.expiresAt);
        return unwrap(result.data);
      };
      const batch = async calls => {
        const values = [];
        for (let offset = 0; offset < calls.length; offset += 20) {
          if (!alive()) throw new Error("Obsolete route");
          const results = await message({ type: "WE_AGO_BATCH", calls: calls.slice(offset, offset + 20).map(call => ({ ...call, ttlSeconds: 120 })) });
          if (!Array.isArray(results) || results.length !== Math.min(20, calls.length - offset)) throw new Error(t("Company data unavailable · retrying"));
          for (const result of results) {
            if (!valid(result.expiresAt)) throw new Error(t("Company data unavailable · retrying"));
            expiries.push(result.expiresAt); values.push(unwrap(result.data));
          }
        }
        return values;
      };
      try {
        // Settings reads are popup-only. The page-approved summary supplies
        // the saved player identity without exposing the API token.
        const summary = await message({ type: "WE_AGO_PLAYER_SUMMARY", includeEquipment: false });
        if (summary?.state === "setup") throw new Error(t("Set token and player ID in extension settings"));
        if (summary?.state !== "ready" || !/^[a-f\d]{24}$/i.test(summary.userId || "")) {
          throw new Error(t("Player identity unavailable · check extension settings"));
        }
        const userId = summary.userId;
        const player = summary.profile?.ok ? unwrap(summary.profile.result?.data) : null;
        const playerExpiry = summary.profile?.result?.expiresAt;
        if (player?._id !== userId || !valid(playerExpiry) || playerExpiry <= Date.now()) throw new Error(t("Player profile unavailable · retrying"));
        expiries.push(playerExpiry);
        const companies = [], cursors = new Set();
        let cursor;
        do {
          const page = await query("company.getCompanies", { userId, perPage: 100, ...(cursor ? { cursor } : {}) });
          if (!Array.isArray(page?.items)) throw new Error(t("Company list unavailable · retrying"));
          companies.push(...page.items);
          cursor = page.nextCursor;
          if (cursor && (typeof cursor !== "string" || cursors.has(cursor))) throw new Error("Company pagination unavailable");
          if (cursor) cursors.add(cursor);
          if (cursors.size > 100) throw new Error("Company pagination unavailable");
        } while (cursor);
        const unique = [...new Map(companies.map(company => [id(company), company])).values()];
        if (unique.some(company => !/^[a-f\d]{24}$/i.test(id(company) || ""))) throw new Error("Company identity unavailable");
        const detailIds = unique.filter(company => typeof company === "string");
        const details = await batch(detailIds.map(companyId => ({ procedure: "company.getById", input: { companyId } })));
        const full = unique.map(company => typeof company === "string" ? details[detailIds.indexOf(company)] : company);
        if (full.some((company, index) => !company || company._id !== id(unique[index]) || id(company.user) !== userId)) throw new Error("Company ownership unavailable");
        const [config, prices] = await Promise.all([
          query("gameConfig.getGameConfig", {}, 600),
          query("itemTrading.getPrices")
        ]);
        const upgrades = await batch(full.map(company => ({ procedure: "upgrade.getUpgradeByTypeAndEntity", input: { upgradeType: "automatedEngine", companyId: company._id } })));
        const bonuses = await batch(full.map(company => ({ procedure: "company.getProductionBonus", input: { companyId: company._id } })));
        const models = new Map(full.map((company, index) => [company._id, economics(company, config, prices, bonuses[index])]));
        const advice = advise(full, new Map(full.map((company, index) => [company._id, upgrades[index]])), config, prices, models,
          player?._id === userId ? player.skills?.companies?.value : null);
        if (!alive()) return;
        errorText = "";
        snapshot = { companies: full, models, advice, expiresAt: Math.min(...expiries) };
        retryAt = Date.now() + 10000;
        clear(); mount();
      } catch (error) {
        if (alive()) {
          retryAt = Date.now() + 30000;
          errorText = error.message;
          mount();
        }
      } finally { pending = false; }
    }
    function sync({ discover = true } = {}) {
      if (stopped) return;
      if (route !== location.href) { route = location.href; generation++; snapshot = undefined; retryAt = 0; errorText = ""; clear(); }
      if (!onRoute()) { clear(); return; }
      if (document.hidden) return;
      mount(discover);
      for (const card of cards.values()) {
        const base = card.title.split(t(" · Last known"))[0];
        card.title = base + (snapshot && Date.now() >= snapshot.expiresAt ? t(" · Last known") + (errorText ? " · " + errorText : t(" · Refreshing…")) : "");
      }
      if (!snapshot || Date.now() >= snapshot.expiresAt) void refresh();
    }
    return {
      sync,
      tick() { sync({ discover: false }); },
      destroy() { stopped = true; generation++; snapshot = undefined; clear(); }
    };
  }
  globalThis.__weAgoCompanyAdvisor = { create, economics, advise };
})();
