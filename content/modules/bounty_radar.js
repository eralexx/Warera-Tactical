"use strict";

(() => {
  const t = (source = "", ...values) => globalThis.__weAgoI18n?.t(source, ...values)
    ?? (typeof source === "string" ? source : source.reduce((text, part, i) => text + part + (i < values.length ? values[i] : ""), ""));

  // The shared shell has no feature-specific requests, timers or listeners.
  // Independently enabled modules own and release only their own sections.
  const contributions = new Map();
  let shell;
  function acquireHost(key) {
    if (!shell) {
      const owned = (tag, suffix) => {
        const node = document.createElement(tag);
        node.className = "we-ago-radar-" + suffix;
        node.dataset.weAgo = "true";
        return node;
      };
      const root = owned("details", "dropdown"), summary = owned("summary", "summary"), panel = owned("div", "panel");
      root.id = "we-ago-bounty-radar";
      root.setAttribute("name", "we-ago-floating");
      root.append(summary, panel);
      let disposed = false, positioned = false, drag, suppressClick = false;
      const place = (left, top) => {
        const width = root.getBoundingClientRect().width || summary.getBoundingClientRect().width;
        const height = summary.getBoundingClientRect().height;
        left = Math.max(12, Math.min(left, innerWidth - width - 12));
        top = Math.max(12, Math.min(top, innerHeight - height - 12 - (root.open ? 100 : 0)));
        root.style.left = left + "px";
        root.style.top = top + "px";
        root.style.setProperty("--we-ago-radar-top", top + "px");
      };
      const constrain = () => {
        if (disposed || !root.isConnected) return;
        const rect = root.getBoundingClientRect();
        place(rect.left, rect.top);
      };
      const persist = () => {
        positioned = true;
        const rect = root.getBoundingClientRect();
        void (globalThis.__weAgoApi?.send ?? chrome.runtime.sendMessage)({ type: "WE_AGO_RADAR_POSITION_SAVE", position: { left: rect.left, top: rect.top } }).then(response => {
          if (!disposed && !response?.ok) summary.title = t("Position could not be saved.");
        }).catch(() => { if (!disposed) summary.title = t("Position could not be saved."); });
      };
      const down = event => {
        if (event.button !== 0 || event.isPrimary === false) return;
        const rect = root.getBoundingClientRect();
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
        suppressClick = false;
        try { summary.setPointerCapture(event.pointerId); } catch {}
      };
      const move = event => {
        if (!drag || event.pointerId !== drag.id) return;
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 5) return;
        drag.moved = true;
        positioned = true;
        root.classList.add("we-ago-radar-dragging");
        place(drag.left + dx, drag.top + dy);
      };
      const end = event => {
        if (!drag || event.pointerId !== drag.id) return;
        const { id, moved } = drag;
        drag = undefined;
        suppressClick = moved;
        root.classList.remove("we-ago-radar-dragging");
        if (summary.hasPointerCapture(id)) summary.releasePointerCapture(id);
        if (moved) persist();
      };
      const click = event => {
        if (suppressClick) { event.preventDefault(); suppressClick = false; }
      };
      const keydown = event => {
        const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        const direction = directions[event.key];
        if (!direction) return;
        event.preventDefault();
        suppressClick = false;
        const rect = root.getBoundingClientRect(), step = event.shiftKey ? 40 : 10;
        place(rect.left + direction[0] * step, rect.top + direction[1] * step);
        persist();
      };
      summary.title = t("Drag to move · Arrow keys to move");
      summary.addEventListener("pointerdown", down);
      summary.addEventListener("pointermove", move);
      summary.addEventListener("pointerup", end);
      summary.addEventListener("pointercancel", end);
      summary.addEventListener("lostpointercapture", end);
      summary.addEventListener("click", click);
      summary.addEventListener("keydown", keydown);
      root.addEventListener("toggle", constrain);
      window.addEventListener("resize", constrain);
      void (globalThis.__weAgoApi?.send ?? chrome.runtime.sendMessage)({ type: "WE_AGO_RADAR_POSITION_GET" }).then(saved => {
        const position = saved?.ok && saved.data;
        if (!disposed && !positioned && Number.isFinite(position?.left) && Number.isFinite(position?.top)) place(position.left, position.top);
      }).catch(() => {});
      shell = { root, summary, panel, dispose() {
        disposed = true;
        drag = undefined;
        summary.removeEventListener("pointerdown", down);
        summary.removeEventListener("pointermove", move);
        summary.removeEventListener("pointerup", end);
        summary.removeEventListener("pointercancel", end);
        summary.removeEventListener("lostpointercapture", end);
        summary.removeEventListener("click", click);
        summary.removeEventListener("keydown", keydown);
        root.removeEventListener("toggle", constrain);
        window.removeEventListener("resize", constrain);
      } };
    }
    const current = shell;
    contributions.set(key, { count: 0, notifying: false });
    const refresh = () => {
      const values = [...contributions.values()];
      current.summary.textContent = "Warera UI Enhancer - " + t("Radar · ") + values.reduce((sum, value) => sum + value.count, 0) + (values.some(value => value.notifying) ? " 🔔" : "");
    };
    const sync = () => { if (document.body && current.root.parentNode !== document.body) document.body.append(current.root); };
    refresh(); sync();
    return { root: current.root, panel: current.panel, sync,
      setCount(count, notifying = false) { contributions.set(key, { count, notifying }); refresh(); },
      destroy() {
        contributions.delete(key);
        if (contributions.size) refresh();
        else { current.dispose(); current.root.remove(); shell = undefined; }
      }
    };
  }
  globalThis.__weAgoRadarHost = { acquire: acquireHost };

  function createController() {
    const host = acquireHost("opportunities");
    let lastIssue = "";
    let alerts = [], root, section, list, status, restore, form, filterTitle;
    let settings = { notifyBounty: false, minimumBounty: 1, minimumDamageBonus: 0 };
    let tracking = { removedBattleIds: [], open: false };
    let stopped = false, received = false, stateRevision = 0, updatedAt = 0, busy = false;
    let navigationTimer, navigationObserver;
    let desiredOpen, openRevision = 0, openQueue = Promise.resolve();
    let scopes = new Set();
    const number = value => Number(value).toLocaleString(globalThis.__weAgoI18n?.locale, { maximumFractionDigits: 3 });
    const owned = (tag, suffix, text) => {
      const node = document.createElement(tag);
      node.className = "we-ago-radar-" + suffix;
      node.dataset.weAgo = "true";
      if (text !== undefined) node.textContent = text;
      return node;
    };

    function stopNavigationWatch() {
      clearTimeout(navigationTimer);
      navigationObserver?.disconnect();
    }

    function navigate(event, link) {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      const target = link.getAttribute("href");
      if (location.pathname === target) return;
      stopNavigationWatch();
      let rendered = false;
      navigationObserver = new MutationObserver(records => {
        if (records.some(record => !record.target.closest?.('[data-we-ago="true"]')
          && [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && !node.matches?.('[data-we-ago="true"]')))) rendered = true;
      });
      navigationObserver.observe(document.body, { childList: true, subtree: true });
      try {
        window.history.pushState({}, "", target);
        window.dispatchEvent(new PopStateEvent("popstate"));
        navigationTimer = setTimeout(() => {
          navigationObserver.disconnect();
          if (!rendered && location.pathname === target) window.location.assign(target);
        }, 1200);
      } catch {
        stopNavigationWatch();
        window.location.assign(target);
      }
    }

    function applyState(next) {
      if (stopped) return;
      if (next.settings) settings = next.settings;
      if (next.tracking) tracking = next.tracking;
      if (!root) return;
      root.open = desiredOpen ?? (root.dataset.weAgoRestoredOpen === undefined ? tracking.open : root.dataset.weAgoRestoredOpen === "true");
      if (!form.dataset.weAgoDraft && !form.contains(document.activeElement)) {
        form.elements.notify.checked = settings.notifyBounty;
        form.elements.bounty.value = settings.minimumBounty;
        form.elements.bonus.value = settings.minimumDamageBonus;
      }
      render();
    }

    async function save(fields) {
      if (stopped || busy) return;
      busy = true;
      root.setAttribute("aria-busy", "true");
      status.textContent = "";
      render();
      try {
        const response = await (globalThis.__weAgoApi?.send ?? chrome.runtime.sendMessage)({ type: "WE_AGO_RADAR_TRACKING_SAVE", ...fields });
        if (!response?.ok) throw new Error(response?.error?.message || t("Could not save radar settings."));
        if (stopped) return;
        stateRevision++;
        delete form.dataset.weAgoDraft;
        applyState(response.data);
        if (fields.action === "rules") status.textContent = t("Saved.");
      } catch (error) {
        if (!stopped) status.textContent = t(error.message) || t("Could not save. Try again.");
      } finally {
        busy = false;
        if (!stopped) { root.setAttribute("aria-busy", "false"); render(); }
      }
    }

    function render() {
      if (!root) return;
      const rows = [];
      if (filterTitle) filterTitle.textContent = t`Filters & alerts · ≥${number(settings.minimumBounty)} /1k · ≥${number(settings.minimumDamageBonus)}%`;
      const visible = alerts.filter(alert => scopes.has(alert.type === "CONTRACT" ? "contracts" : "bounty")
        && !tracking.removedBattleIds.includes(alert.battleId));
      host.setCount(visible.length, settings.notifyBounty);
      restore.hidden = tracking.removedBattleIds.length === 0;
      restore.textContent = t("Restore removed (") + tracking.removedBattleIds.length + ")";
      restore.disabled = busy;
      for (const control of form.querySelectorAll("input, button")) control.disabled = busy;
      if (!visible.length) { const empty = owned("p", "empty", t("No matching battles.")); empty.dataset.rowKey = "empty"; rows.push(empty); }
      for (const alert of visible) {
        const contract = alert.type === "CONTRACT";
        const row = owned("div", "row");
        row.dataset.kind = contract ? "contract" : "bounty";
        row.dataset.rowKey = [alert.type, alert.battleId, alert.side, alert.contractId || ""].join(":");
        if (alert.stale) row.title = t("Last known · refreshing…");
        const link = owned("a", "link");
        link.href = "/battle/" + encodeURIComponent(alert.battleId);
        link.append(owned("strong", "region", (contract ? "📜 " : "💰 ") + alert.regionName));
        const bonus = Number.isFinite(alert.damageBonusPercent) ? " · " + (alert.damageBonusPercent >= 0 ? "+" : "") + number(alert.damageBonusPercent) + t("% damage") : t(" · Bonus unknown");
        const rate = owned("span", "metric");
        globalThis.__weAgoUi.money(rate, (contract ? t("Bid +") : "+") + Number(alert.rate).toFixed(2), t(" / 1k damage") + bonus);
        link.append(rate);
        const available = owned("span", "value");
        globalThis.__weAgoUi.money(available, t("Available ") + number(alert.budget));
        link.append(available);
        link.append(owned("span", "detail", contract
          ? t(alert.side) + t(" · MU auction") + (alert.minimumDamage == null ? "" : t(" · Min ") + number(alert.minimumDamage) + t(" damage")) + (alert.professionalsOnly ? t(" · Professionals") : "")
          : t(alert.side)));
        link.addEventListener("click", event => navigate(event, link));
        const controls = owned("div", "actions");
        const remove = owned("button", "remove", "×");
        remove.type = "button";
        remove.title = t("Remove battle from tracking");
        remove.disabled = busy;
        remove.setAttribute("aria-label", t("Remove ") + alert.regionName + t(" from tracking"));
        remove.addEventListener("click", () => {
          void save({ action: "remove", battleId: alert.battleId });
        });
        controls.append(remove);
        row.append(link, controls);
        rows.push(row);
      }
      globalThis.__weAgoUi.reconcile(list, rows);
    }

    function mount() {
      if (root || !document.body) return;
      root = host.root;
      section = owned("section", "opportunities");
      form = owned("form", "rules");
      const notifyLabel = owned("label", "check");
      const notify = owned("input", "checkbox");
      notify.type = "checkbox";
      notify.name = "notify";
      notifyLabel.append(notify, owned("span", "label", t("Notify for matching opportunities")));
      const thresholds = owned("div", "thresholds");
      for (const [name, label, value] of [["bounty", t("Min bounty / 1k damage"), settings.minimumBounty], ["bonus", t("Min damage bonus %"), settings.minimumDamageBonus]]) {
        const field = owned("label", "field", label);
        const input = owned("input", "number");
        input.type = "number";
        input.name = name;
        if (name === "bounty") input.min = "0";
        input.step = "any";
        input.required = true;
        input.value = String(value);
        field.append(input);
        thresholds.append(field);
      }
      const submit = owned("button", "save", t("Save alerts"));
      submit.type = "submit";
      form.append(notifyLabel, thresholds, submit);
      form.addEventListener("submit", event => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        void save({ action: "rules", notifyBounty: form.elements.notify.checked,
          minimumBounty: Number(form.elements.bounty.value), minimumDamageBonus: Number(form.elements.bonus.value) });
      });
      restore = owned("button", "restore");
      restore.type = "button";
      restore.addEventListener("click", () => void save({ action: "restore" }));
      status = owned("p", "status");
      status.setAttribute("role", "status");
      list = owned("div", "list");
      const filters = owned("details", "filters"); filterTitle = owned("summary", "filter-title", t("Filters & alerts"));
      filters.append(filterTitle, form);
      section.append(status, list, restore, filters);
      host.panel.prepend(section);
      root.addEventListener("toggle", onToggle);
      host.sync();
      applyState({ settings, tracking });
    }

    function sync() {
      if (stopped || !document.body) return;
      mount();
      host.sync();
      if (section.parentNode !== host.panel) host.panel.prepend(section);
      if (updatedAt && Date.now() - updatedAt > 120000 && !busy) status.textContent = lastIssue || t("Last known · refreshing…");
      if (alerts.some(alert => alert.expiresAt && Date.parse(alert.expiresAt) <= Date.now())) {
        alerts = alerts.filter(alert => !alert.expiresAt || Date.parse(alert.expiresAt) > Date.now());
        render();
      }
    }

    function onToggle() {
      if (stopped || root.open === tracking.open && desiredOpen === undefined) return;
      desiredOpen = root.open;
      const revision = ++openRevision, open = desiredOpen;
      openQueue = openQueue.catch(() => {}).then(async () => {
        if (stopped || revision !== openRevision) return;
        const response = await (globalThis.__weAgoApi?.send ?? chrome.runtime.sendMessage)({ type: "WE_AGO_RADAR_TRACKING_SAVE", action: "open", open });
        if (stopped || revision !== openRevision) return;
        if (response?.ok) { tracking.open = open; desiredOpen = undefined; delete root.dataset.weAgoRestoredOpen; }
        else status.textContent = t("Could not save radar settings.");
      }).catch(() => { if (!stopped) status.textContent = t("Could not save radar settings."); });
    }

    function update(next, syncedAt = Date.now()) {
      if (stopped || !Array.isArray(next)) return;
      alerts = next.filter(alert => alert && ["HIGH_BOUNTY", "CONTRACT"].includes(alert.type)
        && /^[a-zA-Z0-9_-]{1,100}$/.test(alert.battleId) && Number.isInteger(alert.roundNumber));
      updatedAt = syncedAt || updatedAt;
      sync();
      render();
    }

    const onMessage = (message, sender) => {
      if (stopped || sender.id !== chrome.runtime.id) return;
      if (message?.type === "WE_AGO_RADAR_STATE") { stateRevision++; applyState(message); }
      if (message?.type === "WE_AGO_RADAR_UPDATE") {
        received = true; lastIssue = message.issue || ""; update(message.payload, message.syncedAt);
        if (!busy) status.textContent = t(message.issue) || "";
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    const initialRevision = stateRevision;
    void (globalThis.__weAgoApi?.send ?? chrome.runtime.sendMessage)({ type: "WE_AGO_RADAR_GET" }).then(response => {
      if (stopped || !response?.ok) return;
      if (stateRevision === initialRevision) applyState(response.data);
      if (!received) { lastIssue = response.data.issue || ""; update(response.data.activeAlerts, response.data.lastRadarSync); }
      if (!received && response.data.issue) status.textContent = t(response.data.issue);
    }).catch(() => { if (!stopped && status) status.textContent = t("Could not load radar. Reload this tab."); });
    sync();
    return { sync, setScopes(next) { scopes = new Set(next); render(); }, destroy() {
      stopped = true;
      chrome.runtime.onMessage.removeListener(onMessage);
      stopNavigationWatch();
      root?.removeEventListener("toggle", onToggle);
      section?.remove();
      host.destroy();
    } };
  }
  // Independently managed feature instances share only their dropdown view.
  const active = new Set();
  let controller;
  function acquire(scope) {
    active.add(scope);
    controller ||= createController();
    controller.setScopes(active);
    let stopped = false;
    const sync = () => { if (!stopped) controller?.sync(); };
    return { sync, tick: sync, destroy() {
      if (stopped) return;
      stopped = true;
      active.delete(scope);
      if (active.size) controller?.setScopes(active);
      else { controller?.destroy(); controller = undefined; }
    } };
  }
  globalThis.__weAgoBountyRadar = { create: () => acquire("bounty") };
  globalThis.__weAgoContractRadar = { create: () => acquire("contracts") };
})();

