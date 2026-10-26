"use strict";

(() => {
  const OWNED = '[data-we-ago="true"]';

  function isOwned(node) {
    const element = node.nodeType === 1 ? node : node.parentElement;
    return Boolean(element?.closest(OWNED));
  }

  // Observe native changes only. Our text/age updates never schedule another pass.
  function start(onChange) {
    let lastUrl = location.href;
    let debounce;
    let deadline;
    let stopped = false;

    function flush() {
      clearTimeout(debounce);
      clearTimeout(deadline);
      debounce = deadline = undefined;
      if (stopped) return;
      const url = location.href;
      const routeChanged = url !== lastUrl;
      lastUrl = url;
      onChange({ url, routeChanged, reason: "mutation" });
    }

    function schedule() {
      if (stopped) return;
      clearTimeout(debounce);
      debounce = setTimeout(flush, 150);
      // A busy SPA cannot indefinitely postpone route detection / remounting.
      if (deadline === undefined) deadline = setTimeout(flush, 1000);
    }

    const observer = new MutationObserver(records => {
      if (records.some(record => {
        // The census owns a roster that the independent readiness module
        // annotates. Only row replacement invalidates discovery, not its clocks.
        if (record.target.matches?.(".we-ago-country-body")) return true;
        if (isOwned(record.target)) return false;
        const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (element?.closest?.('nav, aside, [role="log"], [data-testid*="chat" i], [aria-label*="chat" i]')) return false;
        const changed = [...(record.addedNodes || []), ...(record.removedNodes || [])];
        return changed.length === 0 || changed.some(node => !isOwned(node));
      })) schedule();
    });
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ["href", "id", "alt", "src", "data-company-id", "class", "style", "hidden", "aria-expanded", "aria-haspopup", "disabled", "readonly"]
    });
    // pushState/replaceState do not emit popstate. Poll the URL in the isolated
    // content-script world instead of patching the game's history methods.
    const watcher = setInterval(() => { if (location.href !== lastUrl) schedule(); }, 750);
    window.addEventListener("popstate", schedule);
    window.addEventListener("hashchange", schedule);

    return () => {
      stopped = true;
      observer.disconnect();
      clearInterval(watcher);
      clearTimeout(debounce);
      clearTimeout(deadline);
      window.removeEventListener("popstate", schedule);
      window.removeEventListener("hashchange", schedule);
    };
  }

  globalThis.__weAgoRouteObserver = { start };
})();
