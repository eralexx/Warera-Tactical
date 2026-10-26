"use strict";
// Bounded payload reads; modern key enumeration avoids loading credentials.
globalThis.__weAgoCache = {
  /** @param {StorageAdapter} storage @param {string} prefix */
  create(storage, prefix) {
    const keys = async () => (storage.getKeys ? await storage.getKeys() : Object.keys(await storage.get(null))).filter(key => key.startsWith(prefix)).sort();
    return {
      keys,
      async page(offset = 0, limit = 50) {
        const all = await keys();
        // Entries can expire/be evicted while the popup is on a later page.
        offset = Math.min(offset, Math.max(0, Math.floor((all.length - 1) / limit) * limit));
        const selected = all.slice(offset, offset + limit);
        const values = selected.length ? await storage.get(selected) : {};
        return { entries: selected.filter(key => values[key]).map(key => [key, values[key]]), total: all.length, offset };
      },
      async clear() {
        const all = await keys();
        for (let offset = 0; offset < all.length; offset += 100) await storage.remove(all.slice(offset, offset + 100));
        return {removed:all.length};
      },
      async evict(needed) {
        const all = await keys(); let freed = 0;
        for (let offset = 0; offset < all.length && freed < needed; offset += 100) {
          const selected = all.slice(offset, offset + 100), values = await storage.get(selected), remove = [];
          const sorted = selected.filter(key => values[key]).sort((a,b) => values[a].createdAt - values[b].createdAt);
          for (const key of sorted) {
            if (values[key].expiresAt <= Date.now() || freed < needed) {
              remove.push(key); freed += new TextEncoder().encode(JSON.stringify({[key]:values[key]})).length;
            }
          }
          if (remove.length) await storage.remove(remove);
        }
      },
      async prune() {
        const all = await keys(), cursorKey = "we-ago:cacheSweep";
        const saved = (await storage.get(cursorKey))[cursorKey];
        const offset = Number.isSafeInteger(saved) && saved >= 0 && saved < all.length ? saved : 0;
        const selected = all.slice(offset, offset + 100), values = selected.length ? await storage.get(selected) : {};
        const expired = selected.filter(key => values[key]?.expiresAt <= Date.now());
        if (expired.length) await storage.remove(expired);
        await storage.set({[cursorKey]:offset + 100 >= all.length ? 0 : offset + 100 - expired.length});
        return expired.length;
      }
    };
  }
};
