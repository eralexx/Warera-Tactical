"use strict";

(() => {
  const t = (source = "", ...values) => globalThis.__weAgoI18n?.t(source, ...values)
    ?? (typeof source === "string" ? source : source.reduce((text, part, i) => text + part + (i < values.length ? values[i] : ""), ""));

  const OWNED = '[data-we-ago="true"]';
  const unwrap = value => value && Object.hasOwn(value, "json") ? value.json : value;
  const id = value => typeof value === "string" ? value : value?._id;
  const validId = value => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);

  function netSalary(wage, tax) {
    if (typeof wage !== "number" || !Number.isFinite(wage) || wage < 0
      || typeof tax !== "number" || !Number.isFinite(tax) || tax < 0 || tax > 100) return null;
    return wage * (1 - tax / 100);
  }

  function create() {
    const entries = new Map();
    let stopped = false;

    function companyId(input) {
      const form = input.closest("form");
      const selection = form?.querySelector('input[name="companyId"]');
      // An empty selector means no company is selected; don't use the URL then.
      return selection ? selection.value : location.pathname.match(/^\/company\/([a-f\d]{24})(?:\/|$)/i)?.[1];
    }

    function render(entry) {
      const raw = entry.input.value.trim();
      const wage = /^(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(raw) ? Number(raw.replace(",", ".")) : NaN;
      const tax = entry.tax;
      const amount = netSalary(wage, tax);
      const text = t`Net ${amount === null ? "—" : amount.toLocaleString(globalThis.__weAgoI18n?.locale || "en-US", {
        minimumFractionDigits: 3, maximumFractionDigits: 3
      })}`;
      globalThis.__weAgoUi.money(entry.badge, text, "/PP");
      entry.badge.title = amount !== null ? t`Gold/PP after ${tax}% income tax in ${entry.country}${Date.now() >= entry.expiresAt ? t(" · Last known") : ""}${entry.error ? " · " + entry.error : ""}`
        : entry.error || (Number.isFinite(wage) ? t("Loading income tax…") : t("Enter a valid wage"));
    }

    async function query(procedure, input, ttlSeconds) {
      const response = await (globalThis.__weAgoApi?.send ?? chrome.runtime.sendMessage)({ type: "WE_AGO_QUERY", procedure, input, options: { ttlSeconds } });
      if (!response?.ok) throw new Error(response?.error?.code === "TOKEN_MISSING"
        ? t("Set API token in extension settings") : t("Income tax unavailable · check API connection"));
      const result = response.data;
      if (!Number.isFinite(result?.expiresAt)) throw new Error(t("Income tax unavailable"));
      return { data: unwrap(result.data), expiresAt: result.expiresAt };
    }

    async function refresh(entry) {
      if (entry.pending || Date.now() < entry.retryAt || !validId(entry.companyId)) return;
      entry.pending = true;
      const selected = entry.companyId;
      const alive = () => !stopped && !document.hidden && entries.get(entry.input) === entry
        && entry.input.isConnected && companyId(entry.input) === selected;
      try {
        const company = await query("company.getById", { companyId: selected }, 120);
        if (!alive()) return;
        if (id(company.data) !== selected || !validId(id(company.data?.region))) throw new Error("Company region unavailable");
        const region = await query("region.getById", { regionId: id(company.data.region) }, 600);
        if (!alive()) return;
        if (id(region.data) !== id(company.data.region) || !validId(id(region.data?.country))) throw new Error("Company country unavailable");
        const country = await query("country.getCountryById", { countryId: id(region.data.country) }, 600);
        if (!alive()) return;
        const tax = country.data?.taxes?.income;
        if (id(country.data) !== id(region.data.country) || netSalary(1, tax) === null) throw new Error(t("Income tax unavailable"));
        entry.tax = tax;
        entry.country = country.data.name || "company country";
        entry.expiresAt = Math.min(company.expiresAt, region.expiresAt, country.expiresAt);
        entry.error = "";
      } catch (error) {
        if (alive()) {
          entry.retryAt = Date.now() + 30000;
          entry.error = error.message;
        }
      } finally {
        entry.pending = false;
        if (alive()) render(entry);
      }
    }

    function sync({ discover = true } = {}) {
      if (stopped) return;
      for (const [input, entry] of entries) {
        if (!input.isConnected) { entry.badge.remove(); entries.delete(input); }
      }
      if (document.hidden) return;
      for (const input of discover ? document.querySelectorAll('form input[name="wage"]') : entries.keys()) {
        if (input.closest(OWNED)) continue;
        const label = input.closest("label");
        const heading = label && Array.from(label.children).find(node =>
          node !== input && !node.matches(OWNED) && Boolean(node.textContent.trim()));
        if (!heading) continue;
        const selected = companyId(input);
        let entry = entries.get(input);
        if (entry && entry.companyId !== selected) {
          entry.badge.remove(); entries.delete(input); entry = undefined;
        }
        if (!entry) {
          const badge = document.createElement("span");
          badge.className = "we-ago-net-salary";
          badge.dataset.weAgo = "true";
          entry = { input, badge, companyId: selected, tax: null, expiresAt: 0, retryAt: 0,
            error: validId(selected) ? "" : t("Select a company") };
          entries.set(input, entry);
        }
        // Join the native input's flex row, beside the gross amount. Never
        // move or restyle native controls; only insert our own sibling.
        if (input.nextSibling !== entry.badge) input.after(entry.badge);
        render(entry);
        if (Date.now() >= entry.expiresAt) void refresh(entry);
      }
    }

    // Listen to user edits only; no native form writes or synthetic events.
    const onEdit = event => {
      if (event.target?.matches('input[name="wage"], input[name="companyId"]')) sync();
    };
    document.addEventListener("input", onEdit);
    document.addEventListener("change", onEdit);
    return {
      sync,
      tick() { sync({ discover: false }); },
      destroy() {
        stopped = true;
        document.removeEventListener("input", onEdit);
        document.removeEventListener("change", onEdit);
        for (const entry of entries.values()) entry.badge.remove();
        entries.clear();
      }
    };
  }
  globalThis.__weAgoNetSalary = { create, netSalary };
})();
