"use strict";

(() => {
  const t = (source = "", ...values) => globalThis.__weAgoI18n?.t(source, ...values)
    ?? (typeof source === "string" ? source : source.reduce((text, part, i) => text + part + (i < values.length ? values[i] : ""), ""));

  const labels = { get eco() { return t("💼 Eco"); }, get damage() { return t("⚔️ Damage"); },
    get hybrid() { return t("⚡ Hybrid"); }, get unallocated() { return t("Unallocated"); }, get unknown() { return t("Unknown"); } };
  const owned = (tag, name, text) => {
    const node = document.createElement(tag);
    node.className = "we-ago-country-" + name;
    node.dataset.weAgo = "true";
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const route = () => location.pathname.match(/^\/(?:country|mu)\/([a-zA-Z0-9_-]+)(?:\/(?:citizens|members))?\/?$/)?.[1] || null;
  const routeScope = () => location.pathname.startsWith("/mu/") ? "mu" : "country";
  const pct = value => new Intl.NumberFormat(globalThis.__weAgoI18n?.locale, { maximumFractionDigits: 2 }).format(value);

  function safeColumn(parent) {
    if (!parent || parent === document.body || parent === document.documentElement || parent.id === "__next") return false;
    const style = getComputedStyle(parent);
    return (["block", "flow-root"].includes(style.display) || style.display === "flex" && style.flexDirection === "column"
      || style.display === "grid" && !style.gridTemplateColumns.trim().includes(" "))
      && !["fixed", "absolute"].includes(style.position) && !["hidden", "clip"].includes(style.overflowY);
  }

  function findMuSection() {
    const root = document.getElementById("main-window") || document;
    const native = node => !node.closest('[data-we-ago="true"], nav, aside');
    // The real MU page has two Members labels: a header statistic and the
    // ranked roster. Only the latter shares a section with a native user list.
    const labels = [...root.querySelectorAll('span, h1, h2, h3, h4, [role="heading"]')].filter(node =>
      native(node) && /^(members|military unit members)(?:\s*\(?[\d,]+\)?)?$/i.test(node.textContent.trim()));
    const lists = [...root.querySelectorAll('ul, ol, table, [role="list"]')].filter(node =>
      native(node) && node.querySelector('a[href*="/user/"]'));
    for (const list of lists) {
      let section = list.parentElement;
      while (section && section !== root && section !== document.body) {
        if (labels.some(label => section.contains(label)) || labels.length === 0 && lists.length === 1 && section.children.length > 1) {
          // Never mistake the complete page, including Recent Applications,
          // for the Members section or attach inside its header/filter row.
          if (lists.filter(node => section.contains(node)).length !== 1) break;
          while (section.parentElement && section.parentElement !== root
            && section.parentElement !== document.body
            && [...section.parentElement.children].filter(native).length === 1) section = section.parentElement;
          if (safeColumn(section.parentElement)) return section;
          break;
        }
        section = section.parentElement;
      }
    }
    return null;
  }

  function findMuTopAnchor() {
    const column = findMuSection()?.parentElement;
    return column ? [...column.children].find(node => !node.closest('[data-we-ago="true"]')) ?? null : null;
  }

  function create() {
    let countryId, scope, card, fallback, fields, data, requestId, pending = false, veterans = false, stopped = false;
    let statusText = "", sortKey = "level", ascending = false, lastAttempt = 0, failed = false;
    const current = (id, request) => !stopped && countryId === id && route() === id && routeScope() === scope && requestId === request;
    const people = () => scope === "mu" ? t("members") : t("citizens");

    function unsubscribe() {
      if (pending && requestId) { try { void (globalThis.__weAgoApi?.send ?? chrome.runtime.sendMessage)({type:"WE_AGO_CENSUS_UNSUBSCRIBE",requestId}).catch(() => {}); } catch {} }
    }
    function table() {
      if (!data || !fields.drawer.open) return;
      const rows = data.citizens.filter(user => !veterans || user.level >= 15).sort((a, b) => {
        const av = a[sortKey], bv = b[sortKey];
        const compared = typeof av === "string" ? av.localeCompare(bv) : (av ?? -1) - (bv ?? -1);
        return (ascending ? 1 : -1) * compared || a.id.localeCompare(b.id);
      });
      const signature = JSON.stringify(rows.map(user => [user.id, user.username, user.level, user.build, user.combatShare]));
      // A native details toggle can arrive after our initial render. Preserve
      // identical rows, including the readiness bars another module owns.
      if (fields.body.dataset.signature === signature && fields.body.children.length === rows.length) return;
      fields.body.replaceChildren();
      const fragment = document.createDocumentFragment();
      for (const user of rows) {
        const row = owned("tr", "row");
        const name = owned("td", "cell"), link = owned("a", "link", user.username);
        link.href = "/user/" + encodeURIComponent(user.id);
        name.append(link);
        const badge = owned("td", "cell", labels[user.build]);
        badge.dataset.build = user.build;
        row.append(name, owned("td", "cell", user.level ?? "—"), badge,
          owned("td", "cell", user.combatShare === null ? "—" : `${pct(user.combatShare * 100)} : ${pct((1 - user.combatShare) * 100)}`));
        fragment.append(row);
      }
      fields.body.append(fragment);
      fields.body.dataset.signature = signature;
    }

    function age() {
      if (!fields) return;
      const text = pending || !data ? statusText
        : t`Updated ${Math.max(0, Math.floor((Date.now() - data.createdAt) / 60000))}m ago${data.cachePersisted === false ? t(" · Not cached") : ""}${Date.now() >= data.expiresAt ? t(" · Last known") : ""}${statusText ? " · " + statusText : ""}`;
      if (fields.status.textContent !== text) fields.status.textContent = text;
      fields.refresh.disabled = pending || !failed && Date.now() - Math.max(lastAttempt, data?.createdAt || 0) < 60000;
      const label = failed ? t("Retry") : "↻";
      if (fields.refresh.textContent !== label) fields.refresh.textContent = label;
      fields.refresh.title = pending ? t`Scanning ${people()}` : fields.refresh.disabled ? t("Refresh available after 60 seconds") : t("Refresh census");
      fields.refresh.setAttribute("aria-label", failed ? t("Retry roster scan") : t("Refresh census"));
    }

    function render() {
      if (!fields) return;
      fields.all.setAttribute("aria-pressed", String(!veterans));
      fields.vets.setAttribute("aria-pressed", String(veterans));
      fields.bar.replaceChildren();
      fields.pills.replaceChildren();
      fields.meta.textContent = "";
      for (const field of [fields.bar, fields.pills, fields.meta, fields.drawer]) field.hidden = !data;
      if (data) {
        const summary = veterans ? data.veterans : data.all;
        const accessible = [];
        for (const build of ["eco", "damage", "hybrid"]) {
          const percent = summary[build + "Pct"];
          const label = `${labels[build]}: ${pct(percent)}% (${summary[build]})`;
          const segment = owned("span", "segment");
          segment.dataset.build = build;
          segment.style.width = percent + "%";
          segment.title = label;
          segment.setAttribute("aria-hidden", "true");
          fields.bar.append(segment);
          const pill = owned("span", "pill");
          pill.append(owned("span", "pill-label", labels[build]),
            owned("span", "pill-value", `${pct(percent)}% · ${summary[build]}`));
          pill.dataset.build = build;
          fields.pills.append(pill);
          accessible.push(label);
        }
        fields.bar.setAttribute("aria-label", accessible.join("; "));
        fields.meta.textContent = t`${summary.total} ${people()} · Median level ${summary.medianLevel ?? "—"}`;
        const unclassified = summary.unknown + summary.unallocated;
        if (unclassified) fields.meta.textContent += t` · ${unclassified} unclassified (${summary.unknown} missing skills, ${summary.unallocated} unallocated); % of ${summary.classified} classified`;
        else if (!summary.total) fields.meta.textContent = t`No ${people()} in this group`;
        table();
      }
      age();
    }

    function placement() {
      if (scope === "mu") return findMuTopAnchor();
      // Use the country content sections, never the banner's title or app shell.
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, [role="heading"], a, span, p, div'))
        .filter(node => !node.closest('[data-we-ago="true"]'));
      const rankings = headings.find(node => /^rankings\s*[→➜›]?$/i.test(node.textContent.trim()));
      const government = headings.find(node => /^government\s*[→➜›]?$/i.test(node.textContent.trim()));
      if (!rankings || !government) return null;
      let section = rankings;
      while (section.parentElement && !section.parentElement.contains(government)) section = section.parentElement;
      const parent = section.parentElement;
      if (!parent || parent === document.body || parent.id === "__next"
        || parent === document.documentElement) return null;
      const style = getComputedStyle(parent);
      const vertical = ["block", "flow-root"].includes(style.display)
        || style.display === "flex" && style.flexDirection === "column"
        || style.display === "grid" && !style.gridTemplateColumns.trim().includes(" ");
      if (!vertical || ["hidden", "clip"].includes(style.overflowY)
        || ["fixed", "absolute"].includes(style.position)) return null;
      return section;
    }

    function mount() {
      if (!card) {
        card = owned("section", "builds-card");
        card.dataset.scope = scope; card.dataset.entityId = countryId;
        card.setAttribute("aria-label", scope === "mu" ? t("Member builds") : t("Citizen builds"));
        const header = owned("div", "header"), title = owned("strong", "title", scope === "mu" ? t("Member builds") : t("Citizen builds"));
        const filters = owned("div", "filters");
        filters.setAttribute("role", "group");
        filters.setAttribute("aria-label", t("Citizen level filter"));
        const all = owned("button", "button", t("All")), vets = owned("button", "button", t("Lv 15+"));
        const refresh = owned("button", "button", "↻");
        for (const button of [all, vets, refresh]) button.type = "button";
        all.addEventListener("click", () => { veterans = false; render(); });
        vets.addEventListener("click", () => { veterans = true; render(); });
        refresh.addEventListener("click", () => { if (!refresh.disabled) void load(true); });
        filters.append(all, vets);
        header.append(title, filters);
        const bar = owned("div", "bar");
        bar.setAttribute("role", "img");
        const pills = owned("div", "pills"), meta = owned("div", "meta");
        const footer = owned("div", "footer"), status = owned("span", "status");
        status.setAttribute("role", "status");
        footer.append(status, refresh);
        const drawer = owned("details", "drawer"), toggle = owned("summary", "toggle", scope === "mu" ? t("Members") : t("Citizens"));
        const scroll = owned("div", "scroll"), grid = owned("table", "table"), head = owned("thead", "head");
        const heading = owned("tr", "row"), body = owned("tbody", "body");
        for (const [key, label] of [["username", t("Username")], ["level", t("Level")], ["build", t("Build")], ["combatShare", t("Combat : Eco")]]) {
          const cell = owned("th", "cell"), button = owned("button", "sort", label);
          cell.scope = "col";
          button.type = "button";
          button.addEventListener("click", () => {
            ascending = sortKey === key ? !ascending : key === "username" || key === "build";
            sortKey = key;
            for (const th of heading.children) th.removeAttribute("aria-sort");
            cell.setAttribute("aria-sort", ascending ? "ascending" : "descending");
            table();
          });
          if (key === sortKey) cell.setAttribute("aria-sort", "descending");
          cell.append(button); heading.append(cell);
        }
        head.append(heading); grid.append(head, body); scroll.append(grid); drawer.append(toggle, scroll);
        drawer.addEventListener("toggle", table);
        card.append(header, bar, pills, meta, footer, drawer);
        fields = { all, vets, refresh, bar, pills, meta, status, drawer, body };
        render();
      }
      const section = placement();
      if (section) {
        if (card.parentElement !== section.parentElement || card.nextElementSibling !== section) section.before(card);
        fallback?.remove();
      } else if (document.body) {
        if (!fallback) {
          fallback = owned("details", "fallback");
          fallback.setAttribute("name", "we-ago-floating");
          // Keep the shell out of the game's flex/grid layout even before CSS loads.
          fallback.style.setProperty("position", "fixed", "important");
          fallback.open = false;
          fallback.append(owned("summary", "fallback-toggle", scope === "mu" ? t("Member builds") : t("Country builds")));
        }
        if (card.parentElement !== fallback) fallback.append(card);
        if (fallback.parentElement !== document.body) document.body.append(fallback);
      }
    }

    async function load(forceRefresh = false) {
      if (!countryId || pending) return;
      const id = countryId, request = globalThis.crypto.randomUUID();
      requestId = request;
      pending = true;
      failed = false;
      lastAttempt = Date.now();
      statusText = t`Scanning ${people()}…`;
      render();
      try {
        const response = await (globalThis.__weAgoApi?.send ?? chrome.runtime.sendMessage)({ type: scope === "mu" ? "WE_AGO_GET_MU_BUILDS" : "WE_AGO_GET_COUNTRY_BUILDS",
          ...(scope === "mu" ? { muId: id } : { countryId: id }),
          forceRefresh, excludeLowLevel: veterans, requestId: request });
        if (!current(id, request)) return;
        if (!response?.ok) throw Object.assign(new Error(response?.error?.message || t("Roster scan unavailable. Try refreshing.")), { code: response?.error?.code });
        if (response.data.countryId !== id || response.data.scope && response.data.scope !== scope) throw new Error(t("Roster scan mismatch. Try refreshing."));
        data = response.data;
        statusText = "";
      } catch (error) {
        if (!current(id, request)) return;
        failed = error.code !== "SCAN_CANCELLED";
        if (!failed) lastAttempt = 0;
        statusText = failed ? t(error.message) || t("Roster scan unavailable. Try refreshing.") : "";
      } finally {
        if (current(id, request)) { pending = false; render(); }
      }
    }

    const onProgress = (message, sender) => {
      if (sender.id !== chrome.runtime.id || message?.type !== "WE_AGO_COUNTRY_SCAN_PROGRESS"
        || !pending || !current(message.countryId, message.requestId)) return;
      if (message.scope && message.scope !== scope) return;
      statusText = t`Scanning ${people()} (${message.scanned}/${message.total})…`;
      age();
    };
    chrome.runtime.onMessage.addListener(onProgress);
    function sync({ discover = true } = {}) {
      if (stopped || document.hidden) return;
      const next = route();
      if (next !== countryId || routeScope() !== scope) {
        unsubscribe();
        scope = routeScope();
        countryId = next; requestId = null; pending = false; data = null; lastAttempt = 0; failed = false;
        statusText = ""; card?.remove(); fallback?.remove(); card = fallback = fields = null;
        discover = true;
      }
      if (countryId) {
        if (discover || !card?.isConnected) mount();
        age();
        if ((!data || Date.now() >= data.expiresAt) && !pending && (!lastAttempt || Date.now() - lastAttempt >= 30000)) void load();
      }
    }
    return {
      snapshotState() { return { veterans, sortKey, ascending, open: fields?.drawer.open }; },
      restoreState(state) { if (!state) return; veterans = state.veterans; sortKey = state.sortKey; ascending = state.ascending; if (fields) fields.drawer.open = state.open; render(); },
      sync,
      tick() { sync({ discover: false }); },
      destroy() {
        unsubscribe(); stopped = true; requestId = null; card?.remove(); fallback?.remove();
        chrome.runtime.onMessage.removeListener(onProgress);
      }
    };
  }
  globalThis.__weAgoCountryBuilds = { create, findMuSection, findMuTopAnchor };
})();
