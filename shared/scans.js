"use strict";
globalThis.__weAgoScans = Object.freeze({
  /** @template T @param {T[]} items @param {number} concurrency @param {(item:T)=>void|Promise<void>} action */
  async map(items, concurrency, action) {
    let cursor = 0, failed = false, firstError;
    // Drain already-started readers before rejecting, so settings/cache barriers
    // cannot overtake another worker's in-flight GET and its cache write.
    await Promise.allSettled(Array.from({length:Math.min(concurrency, items.length)}, async () => {
      while (!failed && cursor < items.length) {
        const item = items[cursor++];
        try { await action(item); } catch(error) { failed = true; firstError ??= error; }
      }
    }));
    if (failed) throw firstError;
  }
});
