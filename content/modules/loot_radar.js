"use strict";

(() => {
  const t = (source = "", ...values) => globalThis.__weAgoI18n?.t(source, ...values)
    ?? (typeof source === "string" ? source : source.reduce((text, part, i) => text + part + (i < values.length ? values[i] : ""), ""));

  let countdownEnabled = false;
  const countdownClients = new Set();
  globalThis.__weAgoLootRoundTimer = { create() {
    countdownEnabled = true;
    const update = () => { for (const refresh of countdownClients) refresh(); };
    update();
    return { sync: update, tick: update, destroy() { countdownEnabled = false; update(); } };
  } };

  function create() {
    const host = globalThis.__weAgoRadarHost.acquire("loot");
    let root, list, form, status, summary, filterTitle;
    let stopped = false, pending = false, received = false, updatedAt = 0;
    let snapshot = { settings: { legendaryDamage: null, mythicDamage: null }, items: [], syncedAt: 0, issue: "" };
    let countdownRows = [];
    const owned = (tag, part, text) => {
      const node = document.createElement(tag);
      node.className = "we-ago-loot-" + part;
      node.dataset.weAgo = "true";
      if (text !== undefined) node.textContent = text;
      return node;
    };

    function updateCountdowns() {
      if (stopped) return;
      const now = Date.now();
      for (const entry of countdownRows) {
        if (!countdownEnabled) { entry.node?.remove(); entry.node = undefined; continue; }
        if (!entry.node) {
          entry.node = owned("span", "countdown");
          entry.node.title = t("Estimated current round end if the damage leader wins every remaining tick. Battle loot is awarded at battle end.");
          entry.row.append(entry.node);
        }
        const estimate = entry.item.roundEstimate;
        let text = t("Round ETA —");
        if (Number.isFinite(estimate?.endsAt) && Number.isFinite(estimate?.observedAt)) {
          const seconds = Math.ceil((estimate.endsAt - now) / 1000);
          if (seconds <= 0 || now - estimate.observedAt >= 120000 || estimate.observedAt > now) text = t("Round updating…");
          else text = t("Round ≈ ") + [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60]
            .map(value => String(value).padStart(2, "0")).join(":");
        }
        if (entry.node.textContent !== text) entry.node.textContent = text;
      }
    }
    countdownClients.add(updateCountdowns);

    function render() {
      if (!root) return;
      const rows = [];
      if (filterTitle) {
        const limit = value => value === null ? "—" : value.toLocaleString(globalThis.__weAgoI18n?.locale, {notation:"compact",maximumFractionDigits:1});
        filterTitle.textContent = t`Damage limits · L ≤ ${limit(snapshot.settings.legendaryDamage)} · M ≤ ${limit(snapshot.settings.mythicDamage)}`;
      }
      countdownRows = [];
      summary.textContent = t("Loot targets · ") + snapshot.items.length;
      host.setCount(snapshot.items.length);
      for (const item of snapshot.items) {
        const row = owned("a", "result");
        row.dataset.rarity = item.rarity;
        row.dataset.rowKey = item.targetId;
        row.href = "/battle/" + encodeURIComponent(item.battleId);
        row.title = (item.stale ? t("Last known · ") : "") + t("Combined damage on both sides to pass the current loot recipient; rank and reward can change.");
        row.append(owned("strong", "name", (item.rarity === "legendary" ? t("Legendary") : t("Mythic")) + " · " + item.regionName));
        row.append(owned("span", "damage", t("Current target ") + item.damage.toLocaleString(globalThis.__weAgoI18n?.locale) + t(" damage")));
        row.append(owned("span", "offer", item.itemCode + " · " + (item.scope === "round" ? "R" + item.roundNumber : t("Battle")) + t(" · Both sides · #") + item.rank));
        rows.push(row);
      }
      if (!snapshot.items.length) {
        const empty = owned("p", "empty", snapshot.settings.legendaryDamage === null && snapshot.settings.mythicDamage === null ? t("Set a damage limit.") : t("No matching loot targets."));
        empty.dataset.rowKey = "empty"; rows.push(empty);
      }
      const rendered = globalThis.__weAgoUi.reconcile(list, rows);
      countdownRows = snapshot.items.map((item, index) => ({item, row: rendered[index]}));
      updateCountdowns();
      status.textContent = t(snapshot.issue) || "";
    }

    function apply(next) {
      if (stopped || !next || !next.settings || !Array.isArray(next.items)) return;
      snapshot = { ...next, items: next.items.filter(item => ["legendary", "mythic"].includes(item.rarity)
        && item.side === "merged" && /^[a-zA-Z0-9_-]{1,100}$/.test(item.battleId) && Number.isFinite(item.damage) && typeof item.targetId === "string") };
      updatedAt = next.syncedAt || updatedAt;
      sync();
      if (!form.dataset.weAgoDraft && !form.contains(document.activeElement)) {
        form.elements.legendary.value = snapshot.settings.legendaryDamage ?? "";
        form.elements.mythic.value = snapshot.settings.mythicDamage ?? "";
      }
      render();
    }

    function sync() {
      if (stopped || !document.body) return;
      if (!root) {
        root = owned("section", "section");
        root.id = "we-ago-loot-radar";
        summary = owned("h3", "title", t("Loot targets · 0"));
        const panel = owned("div", "panel");
        form = owned("form", "form");
        for (const rarity of ["legendary", "mythic"]) {
          const label = owned("label", "field", rarity === "legendary" ? t("Legendary max damage") : t("Mythic max damage"));
          const input = owned("input", "input");
          input.name = rarity;
          input.type = "number";
          input.min = "0";
          input.step = "any";
          input.placeholder = t("Off");
          label.append(input);
          form.append(label);
        }
        const save = owned("button", "save", t("Save filter"));
        save.type = "submit";
        form.append(save);
        form.addEventListener("submit", async event => {
          event.preventDefault();
          if (pending || !form.reportValidity()) return;
          const value = name => form.elements[name].value.trim() === "" ? null : Number(form.elements[name].value);
          const settings = { legendaryDamage: value("legendary"), mythicDamage: value("mythic") };
          pending = true;
          save.disabled = true;
          try {
            const response = await (globalThis.__weAgoApi?.send ?? chrome.runtime.sendMessage)({ type: "WE_AGO_LOOT_RADAR_SAVE", settings });
            if (stopped) return;
            if (!response?.ok) throw new Error(response?.error?.message || t("Could not save filter."));
            received = true;
            delete form.dataset.weAgoDraft;
            apply(response.data);
          } catch (error) { if (!stopped) status.textContent = t(error.message) || t("Could not save filter."); }
          finally { pending = false; if (!stopped) save.disabled = false; }
        });
        list = owned("div", "list");
        status = owned("p", "status");
        status.setAttribute("role", "status");
        const filters = owned("details", "filters"); filterTitle = owned("summary", "filter-title", t("Damage limits"));
        filters.append(filterTitle, form);
        panel.append(status, list, filters);
        root.append(summary, panel);
        host.panel.append(root);
        render();
      }
      host.sync();
      if (root.parentNode !== host.panel) host.panel.append(root);
      if (updatedAt && Date.now() - updatedAt > 120000) status.textContent = t(snapshot.issue) || t("Last known · refreshing…");
    }

    const onUpdate = (message, sender) => {
      if (sender.id === chrome.runtime.id && message?.type === "WE_AGO_LOOT_RADAR_UPDATE") { received = true; apply(message.payload); }
    };
    chrome.runtime.onMessage.addListener(onUpdate);
    void (globalThis.__weAgoApi?.send ?? chrome.runtime.sendMessage)({ type: "WE_AGO_LOOT_RADAR_GET" }).then(response => {
      if (!stopped && response?.ok && !received) apply(response.data);
    }).catch(() => { if (!stopped && status) status.textContent = t("Could not load filter. Reload this tab."); });
    sync();
    return { sync, tick: sync, destroy() {
      stopped = true;
      countdownClients.delete(updateCountdowns);
      countdownRows = [];
      chrome.runtime.onMessage.removeListener(onUpdate);
      root?.remove();
      host.destroy();
    } };
  }
  globalThis.__weAgoLootRadar = { create };
})();

