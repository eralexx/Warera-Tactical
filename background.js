"use strict";

// Notifications share the UI catalog; VM test harnesses can omit worker imports.
if (typeof importScripts === "function") importScripts("shared/scans.js", "shared/cache.js", "shared/features.js", "shared/domain.js", "shared/passive_cache.js", "locales/es.js");
const LANGUAGE_KEY = "we-ago:language";
const LANGUAGES = Object.freeze(["en", "es"]);
async function readLanguage() {
  const value = (await chrome.storage.local.get(LANGUAGE_KEY))[LANGUAGE_KEY];
  return LANGUAGES.includes(value) ? value : "en";
}

const SETTINGS_KEY = "we-ago:settings";
const CACHE_PREFIX = "we-ago:cache:";
const MAX_BATCH_QUERIES = 50;
const FEATURES_KEY = "we-ago:features";
const scanGenerations = { census: 0, radar: 0, loot: 0 };
function makeScanCheck(scope, generation = scanGenerations[scope]) {
  return () => {
    if (generation !== scanGenerations[scope]) throw failure("SCAN_CANCELLED", "Scan superseded by updated preferences.");
  };
}
const DEFAULT_FEATURES = Object.freeze(Object.fromEntries(globalThis.__weAgoFeatures.map(({key}) => [key, true])));

async function readFeatures() {
  const values = await chrome.storage.local.get([FEATURES_KEY, "we-ago:radar"]);
  const stored = values[FEATURES_KEY];
  // Preserve the old controls when upgrading an existing Chrome profile.
  const legacy = { spyXray: stored?.tacticalSummary, pillTimeline: stored?.spyXray ?? stored?.tacticalSummary,
    bountyRadar: values["we-ago:radar"]?.enabled,
    contractRadar: stored?.bountyRadar ?? values["we-ago:radar"]?.enabled };
  const features = Object.fromEntries(Object.entries(DEFAULT_FEATURES).map(([key, fallback]) =>
    [key, typeof stored?.[key] === "boolean" ? stored[key]
      : typeof legacy[key] === "boolean" ? legacy[key] : fallback]));
  // Materialize inherited preferences before discarding the retired summary flag.
  if (stored && Object.hasOwn(stored, "tacticalSummary")) {
    await chrome.storage.local.set({ [FEATURES_KEY]: features });
  }
  return features;
}

async function saveFeatures(next) {
  const previous = await readFeatures();
  const features = { ...previous, ...next };
  await chrome.storage.local.set({ [FEATURES_KEY]: features });
  try {
    const tabs = await chrome.tabs.query({ url: ["https://app.warera.io/*", "https://warera.io/*"] });
    await Promise.allSettled(tabs.filter(tab => Number.isInteger(tab.id)).map(tab =>
      chrome.tabs.sendMessage(tab.id, { type: "WE_AGO_FEATURES_CHANGED", features })));
  } catch { /* Saved flags apply on the next page load. */ }
  if (previous.bountyRadar !== features.bountyRadar || previous.contractRadar !== features.contractRadar) {
    await configureRadar();
    await broadcastRadarState();
    if (features.bountyRadar || features.contractRadar) enqueueRadar(pollRadar);
  }
  if (previous.lootRadar !== features.lootRadar) {
    await configureLootRadar();
    if (features.lootRadar) enqueueRadar(pollLootRadar);
  }
  return features;
}

const DISPLAY_KEY = "we-ago:display";
const DEFAULT_MARKET_FONT_SIZE = 11;
const DEFAULT_TTLS = { live: 120, static: 600, default: 120 };
const STATIC_PROCEDURES = /^(region|country)\./;
const MAX_TTL_SECONDS = 172800;
const API_BASES = Object.freeze({ official: "https://api2.warera.io/trpc/", gateway: "https://gateway.warerastats.io/trpc/", official5: "https://api5.warera.io/trpc/" });
const GATEWAY_RETRY_KEY = "we-ago:gatewayRetryAt";
const GATEWAY_COOLDOWN_MS = 60000;
const PROCEDURE_TTLS = Object.freeze({
  "tradingOrder.getTopOrders": 120, "itemTrading.getPrices": 120,
  "user.getUserById": 120, "inventory.fetchCurrentEquipment": 360,
  "mercenaryContract.getActiveForBattle": 60, "mercenaryContract.getContracts": 60,
  "round.getLastHits": 60, "battleOrder.getByBattle": 60,
  "battleLootSummary.getByBattleAndUser": 60, "company.getCompanies": 360,
  "upgrade.getUpgradeByTypeAndEntity": 360, "event.getEventsPaginated": 120
});
// Explicit compatibility list from the gateway's published router. Unknown
// procedures continue through Official, including battle loot summaries.
const GATEWAY_PROCEDURES = new Set([
  "company.getById", "company.getCompanies", "country.getCountryById", "country.getAllCountries",
  "event.getEventsPaginated", "government.getByCountryId", "region.getById", "region.getRegionsObject",
  "battle.getById", "battle.getLiveBattleData", "battle.getBattles", "round.getById", "round.getLastHits",
  "battleRanking.getRanking", "itemTrading.getPrices", "tradingOrder.getTopOrders", "itemOffer.getById",
  "workOffer.getById", "workOffer.getWorkOfferByCompanyId", "workOffer.getWorkOffersPaginated", "ranking.getRanking",
  "gameConfig.getDates", "gameConfig.getGameConfig", "user.getUserLite", "user.getUsersByCountry", "user.getUserById",
  "article.getArticleById", "article.getArticleLiteById", "article.getArticlesPaginated", "mu.getById",
  "mu.getManyPaginated", "transaction.getPaginatedTransactions", "upgrade.getUpgradeByTypeAndEntity",
  "worker.getWorkers", "worker.getTotalWorkersCount", "battleOrder.getByBattle", "inventory.fetchCurrentEquipment"
]);

/** @typedef {{ttlSeconds?: number, forceRefresh?: boolean}} QueryOptions */
/** @typedef {{data: unknown, cached: boolean, key: string, createdAt: number, expiresAt: number, provider: 'official'|'gateway'|'official5'}} QueryResult */
/** @typedef {{itemCode: string, limit?: number}} TopOrdersInput */
/** @typedef {{userId: string}} UserInput */
/** @typedef {{roundId: string}} LastHitsInput */
/** @typedef {{battleId: string, side: 'attacker'|'defender'}} BattleOrdersInput */
/** @typedef {{battleId: string, userId: string}} BattleLootInput */
/** @typedef {{userId?: string, perPage?: number, cursor?: string}} CompaniesInput */
/** @typedef {{upgradeType: 'bunker'|'base'|'pacificationCenter'|'storage'|'automatedEngine'|'breakRoom'|'headquarters'|'dormitories', regionId?: string, companyId?: string, muId?: string}} UpgradeInput */
/** @typedef {{limit?: number, cursor?: string, countryId?: string, eventTypes?: string[]}} EventsInput */

function validateRegisteredInput(procedure, input) {
  const required = {
    "mercenaryContract.getActiveForBattle": ["battleId", "muId"],
    "mercenaryContract.getContracts": ["battleId", "countryId"],
    "tradingOrder.getTopOrders": ["itemCode"], "user.getUserById": ["userId"],
    "inventory.fetchCurrentEquipment": ["userId"], "round.getLastHits": ["roundId"],
    "battleOrder.getByBattle": ["battleId", "side"], "battleLootSummary.getByBattleAndUser": ["battleId", "userId"],
    "upgrade.getUpgradeByTypeAndEntity": ["upgradeType"]
  };
  for (const field of required[procedure] || []) {
    if (typeof input[field] !== "string" || !input[field].trim()) throw failure("INVALID_INPUT", `Missing ${field} for ${procedure}.`);
  }
  if (procedure === "battleOrder.getByBattle" && !["attacker", "defender"].includes(input.side)) {
    throw failure("INVALID_INPUT", "Battle order side must be attacker or defender.");
  }
  const limitField = procedure === "company.getCompanies" ? "perPage" : "limit";
  if (["tradingOrder.getTopOrders", "company.getCompanies", "event.getEventsPaginated", "mercenaryContract.getContracts"].includes(procedure)
    && input[limitField] !== undefined && (!Number.isInteger(input[limitField]) || input[limitField] < 1 || input[limitField] > 100)) {
    throw failure("INVALID_INPUT", `${limitField} must be an integer from 1 to 100.`);
  }
  if (procedure === "mercenaryContract.getContracts" && input.limit !== undefined && input.limit > 50) {
    throw failure("INVALID_INPUT", "Contract limit cannot exceed 50.");
  }
  if (procedure === "upgrade.getUpgradeByTypeAndEntity"
    && !["bunker", "base", "pacificationCenter", "storage", "automatedEngine", "breakRoom", "headquarters", "dormitories"].includes(input.upgradeType)) {
    throw failure("INVALID_INPUT", "Unknown upgrade type.");
  }
  if (procedure === "event.getEventsPaginated" && input.eventTypes !== undefined
    && (!Array.isArray(input.eventTypes) || input.eventTypes.some(value => typeof value !== "string"))) {
    throw failure("INVALID_INPUT", "eventTypes must be an array of strings.");
  }
}

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function ttlSeconds(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_TTL_SECONDS) {
    throw failure("INVALID_TTL", "TTL must be an integer from 0 to 172800 seconds.");
  }
  return value;
}

// Sort object keys so equivalent JSON inputs share a cache entry.
function canonicalJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
    }
    return item;
  });
}

async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function readSettings() {
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
  // Normalize legacy preferences without writing during concurrent reads.
  // Persist the version on the next settings save so values are never doubled twice.
  const savedTtls = Object.fromEntries(Object.entries(stored.ttls || {}).map(([group, value]) =>
    [group, stored.ttlVersion === 2 ? value : Math.min(MAX_TTL_SECONDS, value * 2)]));
  return { contextRevision: Number.isSafeInteger(stored.contextRevision) ? stored.contextRevision : 0, token: stored.token || "", userId: stored.userId || "", apiProvider: stored.apiProvider === "gateway" ? "gateway" : "official", ttls: { ...DEFAULT_TTLS, ...savedTtls } };
}

const responseCache = globalThis.__weAgoCache.create(chrome.storage.local, CACHE_PREFIX);
const CACHE_SWEEP_ALARM = "we-ago-cache-sweep";
let cacheSweepReady;
function ensureCacheSweep() {
  if (!cacheSweepReady) {
    cacheSweepReady = chrome.alarms.get(CACHE_SWEEP_ALARM).then(alarm => {
      if (!alarm) return chrome.alarms.create(CACHE_SWEEP_ALARM, { periodInMinutes: 15 });
    }).catch(error => { cacheSweepReady = undefined; throw error; });
  }
  return cacheSweepReady;
}
async function restoreCacheSweep() {
  if ((await responseCache.keys()).length) await ensureCacheSweep();
  else {
    cacheSweepReady = undefined;
    await chrome.alarms.clear(CACHE_SWEEP_ALARM);
  }
}
async function runCacheSweep() {
  await responseCache.prune();
  await restoreCacheSweep();
}
async function cacheEntries() { return (await responseCache.page(0, 50)).entries; }
async function clearCache() {
  const result = await responseCache.clear();
  cacheSweepReady = undefined;
  await chrome.alarms.clear(CACHE_SWEEP_ALARM).catch(() => {});
  return result;
}

// Cache pressure must not turn a successful read into a failed country scan.
// Evict only disposable response entries; never settings, tokens or radar state.
async function writeResponseCache(writes) {
  const quotaError = error => /quota|QUOTA_BYTES/i.test(error?.message || "");
  try { await chrome.storage.local.set(writes); await ensureCacheSweep().catch(() => {}); return true; }
  catch (error) { if (!quotaError(error)) throw failure("STORAGE_ERROR", "Could not save cache. Try again."); }
  await responseCache.evict(new TextEncoder().encode(JSON.stringify(writes)).length);
  try { await chrome.storage.local.set(writes); await ensureCacheSweep().catch(() => {}); return true; }
  catch (error) {
    if (!quotaError(error)) throw failure("STORAGE_ERROR", "Could not save cache. Try again.");
    // An individual response may exceed the available quota even after eviction.
    // Return the fresh result without caching it rather than losing the scan.
    return false;
  }
}

// One transport scheduler shared by every client, feature and tab in this worker.
// Clients retain validation/cache policy; the scheduler owns only wire batching.
class ApiBatcher {
  constructor() {
    this.pending = [];
    this.inflight = new Map();
    this.active = 0;
    this.scheduled = false;
  }

  read(client, call, provider) {
    if (apiRequestUrl([call], provider).length > 7500) {
      throw failure("INVALID_REQUEST", "Query input exceeds the GET URL limit.");
    }
    const compatible = GATEWAY_PROCEDURES.has(call.procedure);
    // Keep reads outside the published gateway router isolated by procedure.
    // A game-only route can reject the entire HTTP batch before envelopes exist.
    const group = canonicalJson([client.settings.token, provider, compatible, compatible ? "" : call.procedure]);
    const key = canonicalJson([group, call.procedure, call.input]);
    if (this.inflight.has(key)) return this.inflight.get(key);
    const promise = new Promise((resolve, reject) => {
      this.pending.push({ client, call, provider, group, key, resolve, reject });
    });
    this.inflight.set(key, promise);
    this.schedule();
    return promise;
  }

  schedule() {
    if (this.scheduled || !this.pending.length || this.active >= 2) return;
    this.scheduled = true;
    setTimeout(() => { this.scheduled = false; this.flush(); }, 10);
  }

  flush() {
    while (this.pending.length && this.active < 2) {
      const first = this.pending[0];
      const jobs = [];
      for (let index = 0; index < this.pending.length && jobs.length < MAX_BATCH_QUERIES;) {
        const job = this.pending[index];
        if (job.group !== first.group) { index++; continue; }
        const calls = [...jobs, job].map(entry => entry.call);
        // Bound the encoded GET URL as well as the number of procedures.
        if (jobs.length && apiRequestUrl(calls, first.provider).length > 7500) break;
        jobs.push(job);
        this.pending.splice(index, 1);
      }
      this.active++;
      void this.dispatch(jobs).finally(() => { this.active--; this.schedule(); });
    }
  }

  async dispatch(jobs) {
    const { client, provider } = jobs[0];
    try {
      const result = await client.request(jobs.map(job => job.call), provider);
      jobs.forEach((job, index) => job.resolve({ data: result.data[index], provider: result.providers?.[index] ?? result.provider }));
    } catch (error) {
      if (error.outcomes) {
        // Preserve successful envelopes from a mixed HTTP/tRPC response. Do not
        // turn one failed radar read into a second request for every neighbour.
        error.outcomes.forEach((outcome, index) => {
          if (outcome.error) jobs[index].reject(outcome.error);
          else jobs[index].resolve({ data: outcome.data, provider: outcome.provider });
        });
        return;
      }
      // A rejected envelope must not poison an unrelated feature sharing the GET.
      // HTTP/network errors are shared failures and do not trigger fan-out retries.
      if (jobs.length > 1 && ["TRPC_ERROR", "INVALID_RESPONSE"].includes(error.code)) {
        for (const job of jobs) {
          try {
            const result = await client.request([job.call], provider);
            job.resolve({ data: result.data[0], provider: result.provider });
          } catch (issue) { job.reject(issue); }
        }
      } else jobs.forEach(job => job.reject(error));
    } finally {
      jobs.forEach(job => this.inflight.delete(job.key));
    }
  }
}

function apiRequestUrl(calls, provider) {
  const isBatch = calls.length > 1 || provider === "official5";
  const input = isBatch ? Object.fromEntries(calls.map((call, index) => [index, call.input])) : calls[0].input;
  return API_BASES[provider] + calls.map(call => call.procedure).join(",")
    + "?" + (isBatch ? "batch=1&" : "") + "input=" + encodeURIComponent(JSON.stringify(input));
}

const apiBatcher = new ApiBatcher();

const cacheReads = new Map();
async function withCacheReadOrder(keys, forceRefresh, task) {
  const unique = [...new Set(keys)], predecessors = new Set();
  let finish;
  const ticket = { forceRefresh, done: new Promise(resolve => { finish = resolve; }) };
  // Ordinary reads still batch/deduplicate together. A forced refresh follows
  // all earlier reads of the same keys, including their cache writes. Later
  // readers follow that refresh so old responses cannot restore stale data.
  for (const key of unique) {
    const readers = cacheReads.get(key) || new Set();
    for (const previous of readers) if (forceRefresh || previous.forceRefresh) predecessors.add(previous.done);
    readers.add(ticket);
    cacheReads.set(key, readers);
  }
  try {
    await Promise.all(predecessors);
    return await task();
  } finally {
    for (const key of unique) {
      const readers = cacheReads.get(key);
      readers.delete(ticket);
      if (!readers.size) cacheReads.delete(key);
    }
    finish();
  }
}

class WarEraClient {
  constructor(settings, check = () => {}) {
    this.settings = settings;
    this.check = check;
    this.provider = settings.apiProvider === "gateway" ? "gateway" : "official";
  }

  /** @param {TopOrdersInput} input @param {QueryOptions} [options] @returns {Promise<QueryResult>} */
  getTopOrders(input, options = {}) { return this.query("tradingOrder.getTopOrders", input, options); }
  /** @param {QueryOptions} [options] @returns {Promise<QueryResult>} */
  getPrices(options = {}) { return this.query("itemTrading.getPrices", {}, options); }
  /** @param {UserInput} input @param {QueryOptions} [options] @returns {Promise<QueryResult>} */
  getUserById(input, options = {}) { return this.query("user.getUserById", input, options); }
  /** @param {UserInput} input @param {QueryOptions} [options] @returns {Promise<QueryResult>} */
  fetchCurrentEquipment(input, options = {}) { return this.query("inventory.fetchCurrentEquipment", input, options); }
  /** @param {LastHitsInput} input @param {QueryOptions} [options] @returns {Promise<QueryResult>} */
  getLastHits(input, options = {}) { return this.query("round.getLastHits", input, options); }
  /** @param {BattleOrdersInput} input @param {QueryOptions} [options] @returns {Promise<QueryResult>} */
  getBattleOrders(input, options = {}) { return this.query("battleOrder.getByBattle", input, options); }
  /** @param {BattleLootInput} input @param {QueryOptions} [options] @returns {Promise<QueryResult>} */
  getBattleLootSummary(input, options = {}) { return this.query("battleLootSummary.getByBattleAndUser", input, options); }
  /** @param {CompaniesInput} [input] @param {QueryOptions} [options] @returns {Promise<QueryResult>} */
  getCompanies(input = {}, options = {}) { return this.query("company.getCompanies", input, options); }
  /** @param {UpgradeInput} input @param {QueryOptions} [options] @returns {Promise<QueryResult>} */
  getUpgrade(input, options = {}) { return this.query("upgrade.getUpgradeByTypeAndEntity", input, options); }
  /** @param {EventsInput} [input] @param {QueryOptions} [options] @returns {Promise<QueryResult>} */
  getEventsPaginated(input = {}, options = {}) { return this.query("event.getEventsPaginated", input, options); }

  /** @param {{battleId: string, muId: string}} input @param {QueryOptions} [options] @returns {Promise<QueryResult>} */
  getActiveContracts(input, options = {}) { return this.query("mercenaryContract.getActiveForBattle", input, options); }

  /** @param {{battleId: string, countryId: string, status?: string, limit?: number, cursor?: string}} input @param {QueryOptions} [options] @returns {Promise<QueryResult>} */
  getContracts(input, options = {}) { return this.query("mercenaryContract.getContracts", input, options); }

  async query(procedure, input = {}, options = {}) {
    return (await this.batch([{ procedure, input, ttlSeconds: options.ttlSeconds }], options))[0];
  }

  async batch(calls, options = {}) {
    this.check();
    if (!this.settings.token) throw failure("TOKEN_MISSING", "Save an API token first.");
    if (options.settled !== undefined && typeof options.settled !== "boolean") throw failure("INVALID_INPUT", "settled must be boolean.");
    if (options.forceRefresh !== undefined && typeof options.forceRefresh !== "boolean") throw failure("INVALID_INPUT", "forceRefresh must be boolean.");
    if (!Array.isArray(calls) || calls.length === 0 || calls.length > MAX_BATCH_QUERIES) {
      throw failure("INVALID_REQUEST", `Provide between 1 and ${MAX_BATCH_QUERIES} queries.`);
    }
    const accountHash = await digest(this.settings.token);
    const prepared = await Promise.all(calls.map(async (call, index) => {
      // Accept read procedure names only; no arbitrary URLs or mutation methods.
      if (!call || (!/^[a-zA-Z][a-zA-Z0-9]*\.get[a-zA-Z0-9]*$/.test(call.procedure)
        && call.procedure !== "inventory.fetchCurrentEquipment")) {
        throw failure("INVALID_PROCEDURE", "Only named read procedures and inventory.fetchCurrentEquipment are supported.");
      }
      const input = call.input ?? {};
      if (typeof input !== "object" || Array.isArray(input)) {
        throw failure("INVALID_INPUT", "Query input must be a JSON object.");
      }
      validateRegisteredInput(call.procedure, input);
      const group = STATIC_PROCEDURES.test(call.procedure) ? "static"
        : /^(battle|battleOrder|tradingOrder)\./.test(call.procedure) ? "live" : "default";
      const requestedTtl = ttlSeconds(call.ttlSeconds ?? options.ttlSeconds ?? PROCEDURE_TTLS[call.procedure] ?? this.settings.ttls[group]);
      const ttl = group === "live" ? Math.min(120, requestedTtl) : group === "static" ? Math.min(600, requestedTtl) : requestedTtl;
      const key = CACHE_PREFIX + await digest(accountHash + ":" + this.provider + ":" + call.procedure + ":" + canonicalJson(input));
      return { index, procedure: call.procedure, input, ttl, key };
    }));
    return withCacheReadOrder(prepared.map(call => call.key), options.forceRefresh === true,
      () => this.resolveBatch(prepared, options));
  }

  async resolveBatch(prepared, options) {
    this.check();
    const results = new Array(prepared.length), misses = [];
    const stored = await chrome.storage.local.get([...new Set(prepared.map(call => call.key))]);
    const passiveEnabled = Object.values(stored).some(entry => entry?.passive) ? (await readFeatures()).passiveCache : false;
    this.check();
    for (const call of prepared) {
      const { index, ttl, key } = call;
      const cached = stored[key];
      const now = Date.now();
      if (!options.forceRefresh && ttl > 0 && cached && cached.expiresAt > now
        && cached.createdAt <= now && now - cached.createdAt < ttl * 1000
        && (!cached.passive || passiveEnabled)) {
        results[index] = { data: cached.data, cached: true, key, createdAt: cached.createdAt, expiresAt: cached.expiresAt, provider: cached.provider || this.provider };
      } else {
        misses.push(call);
      }
    }
    const settledResults = () => results.map(result => result?.error ? { ok: false, error: result.error }
      : { ok: true, result });
    if (!misses.length) return options.settled ? settledResults() : results;

    const received = await Promise.allSettled(misses.map(call => {
      const compatible = GATEWAY_PROCEDURES.has(call.procedure);
      const provider = ["mercenaryContract.getActiveForBattle", "mercenaryContract.getContracts"].includes(call.procedure) ? "official5"
        : this.provider === "gateway" && compatible ? "gateway" : "official";
      return apiBatcher.read(this, call, provider).then(value => ({ ...value, createdAt: Date.now() }));
    }));
    const writes = {};
    let firstError;
    for (const [index, call] of misses.entries()) {
      const outcome = received[index];
      if (outcome.status === "rejected") {
        const error = outcome.reason;
        firstError ??= error;
        results[call.index] = { error: { code: error.code || "INTERNAL_ERROR", message: error.message,
          ...(Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}),
          ...(Number.isFinite(error.retryAt) ? { retryAt: error.retryAt } : {}) } };
        continue;
      }
      const { data, provider, createdAt } = outcome.value;
      const expiresAt = createdAt + call.ttl * 1000;
      results[call.index] = { data, cached: false, key: call.key, createdAt, expiresAt, provider };
      if (call.ttl > 0) writes[call.key] = { procedure: call.procedure, createdAt, expiresAt, data, provider };
      else await chrome.storage.local.remove(call.key);
    }
    if (Object.keys(writes).length) await writeResponseCache(writes);
    this.check();
    if (options.settled) return settledResults();
    if (firstError) throw firstError;
    return results;
  }

  async request(calls, provider) {
    const retryAt = (await chrome.storage.local.get(GATEWAY_RETRY_KEY))[GATEWAY_RETRY_KEY] || 0;
    // Bypass an unhealthy gateway across clients and worker restarts. A retry
    // goes straight to the transport so Official 429 cannot bounce back again.
    if (provider === "gateway" && retryAt > Date.now()) return this.requestOnce(calls, "official");
    try {
      return await this.requestOnce(calls, provider);
    } catch (error) {
      if (error.outcomes?.some(outcome => !outcome.error)) {
        const outcomes = error.outcomes;
        const failed = outcomes.flatMap((outcome, index) => outcome.error ? [index] : []);
        const fallback = provider === "gateway" ? "official"
          : provider === "official" && retryAt <= Date.now()
            && failed.every(index => outcomes[index].error.httpStatus === 429 && GATEWAY_PROCEDURES.has(calls[index].procedure)) ? "gateway" : null;
        if (!fallback) throw error;
        if (provider === "gateway") await chrome.storage.local.set({ [GATEWAY_RETRY_KEY]: Date.now() + GATEWAY_COOLDOWN_MS });
        try {
          const result = await this.requestOnce(failed.map(index => calls[index]), fallback);
          failed.forEach((index, offset) => { outcomes[index] = { data: result.data[offset], provider: result.provider }; });
        } catch (issue) {
          failed.forEach((index, offset) => { outcomes[index] = issue.outcomes?.[offset] ?? { error: issue }; });
        }
        const rejected = outcomes.find(outcome => outcome.error);
        if (rejected) throw Object.assign(rejected.error, { outcomes });
        return { data: outcomes.map(outcome => outcome.data), providers: outcomes.map(outcome => outcome.provider) };
      }
      if (provider === "gateway") {
        await chrome.storage.local.set({ [GATEWAY_RETRY_KEY]: Date.now() + GATEWAY_COOLDOWN_MS });
        return this.requestOnce(calls, "official");
      }
      if (provider !== "official" || error.httpStatus !== 429 || retryAt > Date.now()
        || !calls.every(call => GATEWAY_PROCEDURES.has(call.procedure))) throw error;
      try {
        return await this.requestOnce(calls, "gateway");
      } catch {
        await chrome.storage.local.set({ [GATEWAY_RETRY_KEY]: Date.now() + GATEWAY_COOLDOWN_MS });
        // A gateway rejection does not prove the Official credential is bad.
        throw error;
      }
    }
  }

  async requestOnce(calls, provider) {
    const isBatch = calls.length > 1 || provider === "official5";
    const url = apiRequestUrl(calls, provider);
    const rateKey = "we-ago:rateLimit:" + await digest(this.settings.token) + ":" + provider;
    const retryAt = (await chrome.storage.local.get(rateKey))[rateKey] || 0;
    if (retryAt > Date.now()) throw Object.assign(failure("HTTP_ERROR", "API rate limit reached. Retrying shortly."), {
      httpStatus: 429, retryAt, provider
    });
    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { Authorization: "Bearer " + this.settings.token, Accept: "application/json",
          ...(provider === "gateway" ? { "X-API-Key": this.settings.token } : {}) },
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(15000)
      });
    } catch {
      throw failure("NETWORK_ERROR", "Request failed or timed out. Check your connection and try again.");
    }
    if (response.status === 429) {
      const header = response.headers?.get("Retry-After");
      const seconds = header === null || header === undefined ? NaN : Number(header);
      const delay = Number.isFinite(seconds) ? seconds * 1000 : (Date.parse?.(header) || 0) - Date.now();
      const retryAt = Date.now() + Math.max(1000, Math.min(300000, delay > 0 ? delay : 60000));
      await chrome.storage.local.set({ [rateKey]: retryAt });
      throw Object.assign(failure("HTTP_ERROR", "API rate limit reached. Retrying shortly."), { httpStatus: 429, retryAt, provider });
    }
    if (!response.ok && response.status !== 207 && ![400, 404, 405].includes(response.status)) {
      throw Object.assign(failure("HTTP_ERROR", `WarEra returned HTTP ${response.status}. Check your token and query input.`), { httpStatus: response.status });
    }
    let payload;
    try { payload = await response.json(); }
    catch {
      if (!response.ok) throw Object.assign(failure("HTTP_ERROR", `WarEra returned HTTP ${response.status}.`), { httpStatus: response.status });
      throw failure("INVALID_RESPONSE", "WarEra returned invalid JSON.");
    }
    const envelopes = isBatch ? payload : [payload];
    if (!Array.isArray(envelopes) || envelopes.length !== calls.length) {
      throw failure("INVALID_RESPONSE", "Unexpected tRPC response shape.");
    }
    const outcomes = envelopes.map((envelope, index) => {
      if (envelope?.error) {
        return { error: Object.assign(failure("TRPC_ERROR", "WarEra rejected the query. Check your token, procedure, and input."), {
          httpStatus: envelope.error.data?.httpStatus ?? envelope.error.json?.data?.httpStatus ?? (!response.ok ? response.status : undefined),
          procedure: calls[index].procedure, provider
        }) };
      }
      if (!envelope?.result || !Object.hasOwn(envelope.result, "data")) {
        return { error: Object.assign(failure("INVALID_RESPONSE", "Missing tRPC result data."), { procedure: calls[index].procedure, provider }) };
      }
      return { data: envelope.result.data, provider };
    });
    const rejected = outcomes.find(outcome => outcome.error);
    if (outcomes.some(outcome => outcome.error?.httpStatus === 429)) {
      await chrome.storage.local.set({ [rateKey]: Date.now() + 60000 });
    }
    if (rejected) throw Object.assign(rejected.error, { outcomes });
    return { data: outcomes.map(outcome => outcome.data), provider };
  }
}

async function handleMessage(message, sender, scanVersions = { ...scanGenerations }) {
  if (sender.id !== chrome.runtime.id) throw failure("FORBIDDEN", "Unknown message sender.");
  // Settings and cache administration belong to this extension's popup only.
  const isPopup = sender.url === chrome.runtime.getURL("popup.html");
  if (!message || typeof message.type !== "string") throw failure("INVALID_REQUEST", "Missing message type.");
  const isGamePage = /^https:\/\/(app\.)?warera\.io\//.test(sender.url || "");
  if (message.type === "WE_AGO_CENSUS_UNSUBSCRIBE") {
    if (!isGamePage || typeof message.requestId !== "string") throw failure("FORBIDDEN", "Invalid scan subscriber.");
    cancelledSubscribers.set(censusSubscriberKey(sender,message.requestId), Date.now());
    while (cancelledSubscribers.size > 1000) cancelledSubscribers.delete(cancelledSubscribers.keys().next().value);
    let removed = 0;
    for (const job of censusJobs.values()) for (const subscriber of job.subscribers) {
      if (subscriber.sender.tab?.id === sender.tab?.id && subscriber.sender.frameId === sender.frameId && subscriber.requestId === message.requestId) {job.subscribers.delete(subscriber); removed++;}
    }
    return {removed};
  }
  if (message.type === "WE_AGO_CONTEXT_GET") {
    if (!isGamePage && !isPopup) throw failure("FORBIDDEN", "Unknown context reader.");
    return { revision: (await readSettings()).contextRevision };
  }
  if (message.type === "WE_AGO_CACHE_WARM") {
    if (!isGamePage) throw failure("FORBIDDEN", "Cache warming is available only on WarEra pages.");
    const settings = await readSettings(), record = message.record;
    if (message.contextRevision !== settings.contextRevision) throw failure("CONTEXT_CHANGED", "Connection changed.");
    if (!(await readFeatures()).passiveCache || !settings.token) return { warmed: false };
    if (!globalThis.__weAgoPassiveCache.valid(record) || record.receivedAt > Date.now()
      || Date.now() - record.receivedAt >= 120000) throw failure("INVALID_INPUT", "Invalid cache observation.");
    validateRegisteredInput(record.procedure, record.input);
    const group = STATIC_PROCEDURES.test(record.procedure) ? "static"
      : /^(battle|battleOrder|tradingOrder)\./.test(record.procedure) ? "live" : "default";
    const requestedTtl = ttlSeconds(PROCEDURE_TTLS[record.procedure] ?? settings.ttls[group]);
    const ttl = group === "static" ? Math.min(600, requestedTtl) : group === "live" ? Math.min(120, requestedTtl) : requestedTtl;
    if (!ttl) return { warmed: false };
    const key = CACHE_PREFIX + await digest(await digest(settings.token) + ":" + settings.apiProvider + ":" + record.procedure + ":" + canonicalJson(record.input));
    return withCacheReadOrder([key], true, async () => {
      const previous = (await chrome.storage.local.get(key))[key];
      // New native reads refresh older observations; replays and fresh worker
      // responses remain protected. Serialize against forced worker refreshes.
      if (previous?.expiresAt > Date.now() && (!previous.passive || previous.createdAt >= record.receivedAt)
        || record.receivedAt + ttl * 1000 <= Date.now()) return { warmed: false };
      const warmed = await writeResponseCache({ [key]: { procedure: record.procedure, data: record.data,
        createdAt: record.receivedAt, expiresAt: record.receivedAt + ttl * 1000,
        provider: record.provider, passive: true } });
      return { warmed };
    });
  }
  if (message.contextRevision !== undefined && ["WE_AGO_QUERY", "WE_AGO_BATCH", "WE_AGO_PLAYER_SUMMARY", "WE_AGO_GET_COUNTRY_BUILDS", "WE_AGO_GET_MU_BUILDS"].includes(message.type)
    && message.contextRevision !== (await readSettings()).contextRevision) throw failure("CONTEXT_CHANGED", "Connection changed.");
  if (["WE_AGO_RADAR_POSITION_GET", "WE_AGO_RADAR_POSITION_SAVE"].includes(message.type)) {
    if (!isGamePage && !isPopup) throw failure("FORBIDDEN", "Radar position is available only on WarEra pages.");
    const key = "we-ago:radar-position";
    const valid = position => position && [position.left, position.top].every(value => Number.isFinite(value) && value >= 0 && value <= 1000000);
    if (message.type.endsWith("SAVE")) {
      if (!valid(message.position)) throw failure("INVALID_INPUT", "Invalid Radar position.");
      await chrome.storage.local.set({ [key]: { left: message.position.left, top: message.position.top } });
    }
    const position = (await chrome.storage.local.get(key))[key];
    return valid(position) ? position : null;
  }
  if (message.type === "WE_AGO_RADAR_TRACKING_SAVE") {
    if (!isGamePage && !isPopup) throw failure("FORBIDDEN", "Radar controls are available only on WarEra pages.");
    return saveRadarTracking(message);
  }
  if (["WE_AGO_LOOT_RADAR_GET", "WE_AGO_LOOT_RADAR_SAVE"].includes(message.type)) {
    if (!isGamePage && !isPopup) throw failure("FORBIDDEN", "Item filters are available only on WarEra pages.");
    if (message.type === "WE_AGO_LOOT_RADAR_SAVE") {
      const next = message.settings;
      if (!next || [next.legendaryDamage, next.mythicDamage].some(value => value !== null && (!Number.isFinite(value) || value < 0))) throw failure("INVALID_INPUT", "Enter a nonnegative damage limit or leave it blank.");
      await chrome.storage.local.set({ [LOOT_RADAR_SETTINGS_KEY]: { legendaryDamage: next.legendaryDamage, mythicDamage: next.mythicDamage } });
      await configureLootRadar();
      await broadcastRadar({ type: "WE_AGO_LOOT_RADAR_UPDATE", payload: await lootRadarSnapshot() });
      enqueueRadar(pollLootRadar);
    }
    return lootRadarSnapshot();
  }
  if (["WE_AGO_GET_COUNTRY_BUILDS", "WE_AGO_GET_MU_BUILDS"].includes(message.type)) {
    if (!isGamePage) throw failure("FORBIDDEN", "Country scans are available only on WarEra pages.");
    return getCountryBuilds(message, sender, makeScanCheck("census", scanVersions.census));
  }
  if (message.type === "WE_AGO_PLAYER_SUMMARY" && !isGamePage && !isPopup) {
    throw failure("FORBIDDEN", "Player summaries are available only on WarEra pages.");
  }
  if (["WE_AGO_LANGUAGE_GET", "WE_AGO_DISPLAY_GET", "WE_AGO_FEATURES_GET", "WE_AGO_RADAR_GET"].includes(message.type) && !isGamePage && !isPopup) {
    throw failure("FORBIDDEN", "Display preferences are available only on WarEra pages.");
  }
  if (!["WE_AGO_QUERY", "WE_AGO_BATCH", "WE_AGO_PLAYER_SUMMARY", "WE_AGO_LANGUAGE_GET", "WE_AGO_DISPLAY_GET", "WE_AGO_FEATURES_GET", "WE_AGO_RADAR_GET"].includes(message.type) && !isPopup) {
    throw failure("FORBIDDEN", "Open the extension popup to manage settings.");
  }
  switch (message.type) {
    case "WE_AGO_LANGUAGE_GET": return { language: await readLanguage() };
    case "WE_AGO_LANGUAGE_SAVE": {
      if (!LANGUAGES.includes(message.language)) throw failure("INVALID_LANGUAGE", "Choose English or Español.");
      await chrome.storage.local.set({ [LANGUAGE_KEY]: message.language });
      try {
        const tabs = await chrome.tabs.query({ url: ["https://app.warera.io/*", "https://warera.io/*"] });
        await Promise.allSettled(tabs.filter(tab => Number.isInteger(tab.id)).map(tab =>
          chrome.tabs.sendMessage(tab.id, { type: "WE_AGO_LANGUAGE_CHANGED", language: message.language })));
      } catch { /* Saved language is restored when the next tab opens. */ }
      return { language: message.language };
    }
    case "WE_AGO_RADAR_GET": {
      const stored = await chrome.storage.local.get(["activeAlerts", "lastRadarSync", "radarIssue"]);
      const tracking = await readRadarTracking();
      const settings = await readRadarSettings();
      return { settings, tracking, activeAlerts: visibleRadarAlerts(stored.activeAlerts || [], tracking, settings), lastRadarSync: stored.lastRadarSync || 0, issue: stored.radarIssue || "" };
    }
    case "WE_AGO_RADAR_SAVE": {
      const next = message.settings;
      if (!next || (next.enabled !== undefined && typeof next.enabled !== "boolean") || !Number.isFinite(next.minimumBounty) || next.minimumBounty < 0) {
        throw failure("INVALID_RADAR", "Enter a nonnegative minimum bounty.");
      }
      if (typeof next.enabled === "boolean") await saveFeatures({ bountyRadar: next.enabled });
      const settings = { ...await readRadarSettings(), minimumBounty: next.minimumBounty };
      await chrome.storage.local.set({ [RADAR_SETTINGS_KEY]: settings });
      await configureRadar();
      await broadcastRadarState();
      enqueueRadar(pollRadar);
      return settings;
    }
    case "WE_AGO_FEATURES_GET": return readFeatures();
    case "WE_AGO_FEATURES_SAVE": {
      if (!message.features || typeof message.features !== "object" || Array.isArray(message.features)
        || Object.entries(message.features).some(([key, value]) => !Object.hasOwn(DEFAULT_FEATURES, key) || typeof value !== "boolean")) {
        throw failure("INVALID_FEATURES", "Feature flags must be known boolean settings.");
      }
      return saveFeatures(message.features);
    }
    case "WE_AGO_DISPLAY_GET": {
      const stored = (await chrome.storage.local.get(DISPLAY_KEY))[DISPLAY_KEY];
      const size = stored?.marketFontSize;
      return { marketFontSize: Number.isInteger(size) && size >= 7 && size <= 14 ? size : DEFAULT_MARKET_FONT_SIZE };
    }
    case "WE_AGO_DISPLAY_SAVE": {
      const size = message.marketFontSize;
      if (!Number.isInteger(size) || size < 7 || size > 14) {
        throw failure("INVALID_FONT_SIZE", "Market font size must be an integer from 7 to 14 pixels.");
      }
      const display = { marketFontSize: size };
      await chrome.storage.local.set({ [DISPLAY_KEY]: display });
      // Preferences contain no token. Existing host permissions cover these tabs.
      try {
        const tabs = await chrome.tabs.query({ url: ["https://app.warera.io/*", "https://warera.io/*"] });
        await Promise.allSettled(tabs.filter(tab => Number.isInteger(tab.id)).map(tab =>
          chrome.tabs.sendMessage(tab.id, { type: "WE_AGO_DISPLAY_CHANGED", display })));
      } catch { /* Saved preferences still apply when a tab is reloaded. */ }
      return display;
    }
    case "WE_AGO_PLAYER_SUMMARY": {
      if (message.includeEquipment !== undefined && typeof message.includeEquipment !== "boolean") throw failure("INVALID_INPUT", "includeEquipment must be boolean.");
      if (message.forceRefresh !== undefined && typeof message.forceRefresh !== "boolean") throw failure("INVALID_INPUT", "forceRefresh must be boolean.");
      const settings = await readSettings();
      if (!settings.token || !settings.userId) return { state: "setup" };
      const client = new WarEraClient(settings);
      // Independent queries preserve the profile if equipment is unavailable.
      const outcomes = await Promise.allSettled([
        client.query("user.getUserById", { userId: settings.userId }, { forceRefresh: message.forceRefresh === true }),
        ...(message.includeEquipment === false ? [] : [client.query("inventory.fetchCurrentEquipment", { userId: settings.userId }, { ttlSeconds: 120, forceRefresh: message.forceRefresh === true })])
      ]);
      const summarize = outcome => outcome.status === "fulfilled"
        ? { ok: true, result: outcome.value }
        : { ok: false, error: {
          code: outcome.reason?.code || "INTERNAL_ERROR",
          ...(Number.isInteger(outcome.reason?.httpStatus) ? { httpStatus: outcome.reason.httpStatus } : {}),
          message: "Player data could not be loaded. Check API settings in the popup."
        } };
      return { state: "ready", userId: settings.userId,
        profile: summarize(outcomes[0]), ...(message.includeEquipment === false ? {} : { equipment: summarize(outcomes[1]) }) };
    }
    case "WE_AGO_SETTINGS_GET": {
      const settings = await readSettings();
      return { hasToken: Boolean(settings.token), userId: settings.userId, apiProvider: settings.apiProvider, ttls: settings.ttls };
    }
    case "WE_AGO_SETTINGS_SAVE": {
      const previous = await readSettings();
      const apiProvider = message.apiProvider ?? previous.apiProvider;
      if (typeof apiProvider !== "string" || !Object.hasOwn(API_BASES, apiProvider)) throw failure("INVALID_PROVIDER", "Choose Official or Community Gateway.");
      const token = message.token === undefined ? previous.token : String(message.token).trim().replace(/^Bearer\s+/i, "");
      if (/[\r\n]/.test(token) || token.length > 8192) throw failure("INVALID_TOKEN", "Invalid token format.");
      const ttls = { ...previous.ttls, ...message.ttls };
      for (const value of Object.values(ttls)) ttlSeconds(value);
      const userId = String(message.userId ?? previous.userId).trim();
      if (message.userId !== undefined && userId && !/^[a-f\d]{24}$/i.test(userId)) throw failure("INVALID_INPUT", "Enter the 24-character player ID from your profile URL.");
      if (token !== previous.token || apiProvider !== previous.apiProvider) {
        await clearCache();
        await chrome.storage.local.remove(GATEWAY_RETRY_KEY);
      }
      const connectionChanged = token !== previous.token || apiProvider !== previous.apiProvider;
      const playerChanged = userId !== previous.userId;
      const contextRevision = previous.contextRevision + (connectionChanged || playerChanged ? 1 : 0);
      await chrome.storage.local.set({ [SETTINGS_KEY]: { token, userId, apiProvider, ttls, ttlVersion: 2, contextRevision }, "we-ago:radarAuthInvalid": false });
      if (token !== previous.token || apiProvider !== previous.apiProvider) {
        await publishRadar([], 0);
        await publishLootRadar([], 0);
      }
      if (connectionChanged || playerChanged) {
        const tabs = await chrome.tabs.query({url:["https://app.warera.io/*","https://warera.io/*"]});
        await Promise.allSettled(tabs.filter(tab=>Number.isInteger(tab.id)).map(tab=>chrome.tabs.sendMessage(tab.id,{
          type:"WE_AGO_CONTEXT_CHANGED",revision:contextRevision,connectionChanged,playerChanged
        })));
      }
      await configureRadar();
      await configureLootRadar();
      enqueueRadar(pollRadar);
      enqueueRadar(pollLootRadar);
      return { hasToken: Boolean(token), userId, apiProvider, ttls };
    }
    case "WE_AGO_CACHE_LIST": {
      const offset = message.offset ?? 0, limit = message.limit ?? 50;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw failure("INVALID_INPUT", "Invalid cache page.");
      const page = await responseCache.page(offset, limit);
      const entries = page.entries.map(([key, entry]) => ({
        key, procedure: entry.procedure, createdAt: entry.createdAt, expiresAt: entry.expiresAt,
        expired: entry.expiresAt <= Date.now(), provider: entry.provider || "official"
      })).sort((a, b) => b.createdAt - a.createdAt);
      return message.paged ? {entries, total:page.total, offset:page.offset, limit} : entries;
    }
    case "WE_AGO_CACHE_CLEAR": return clearCache();
    case "WE_AGO_QUERY": return new WarEraClient(await readSettings()).query(message.procedure, message.input, message.options);
    case "WE_AGO_BATCH": return new WarEraClient(await readSettings()).batch(message.calls, message.options);
    default: throw failure("UNKNOWN_MESSAGE", "Unknown extension message.");
  }
}

// Admit reads together, but drain them before any settings/cache/state write.
// Later reads wait behind that write, preserving account and clear-cache ordering.
let queue = Promise.resolve();
const activeReads = new Set();
const READ_MESSAGES = new Set(["WE_AGO_CENSUS_UNSUBSCRIBE", "WE_AGO_CONTEXT_GET", "WE_AGO_RADAR_POSITION_GET", "WE_AGO_QUERY", "WE_AGO_BATCH", "WE_AGO_PLAYER_SUMMARY",
  "WE_AGO_LANGUAGE_GET",
  "WE_AGO_GET_COUNTRY_BUILDS", "WE_AGO_GET_MU_BUILDS", "WE_AGO_FEATURES_GET",
  "WE_AGO_DISPLAY_GET", "WE_AGO_RADAR_GET", "WE_AGO_LOOT_RADAR_GET", "WE_AGO_SETTINGS_GET", "WE_AGO_CACHE_LIST"]);

function enqueueOperation(task, readOnly = false) {
  let operation;
  const admitted = queue.then(async () => {
    if (!readOnly) await Promise.allSettled([...activeReads]);
    operation = Promise.resolve().then(task);
    if (!readOnly) return operation;
    activeReads.add(operation);
    operation.then(() => activeReads.delete(operation), () => activeReads.delete(operation));
  });
  queue = admitted.catch(() => {});
  return admitted.then(() => operation);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const scanVersions = { ...scanGenerations };
  const invalidated = invalidateScansForWrite(message, sender);
  const operation = enqueueOperation(() => handleMessage(message, sender, scanVersions), READ_MESSAGES.has(message?.type));
  operation.then(data => {
    // An unchanged flag save may still have interrupted a scan; re-evaluate
    // current settings instead of reviving a closure with obsolete filters.
    if (invalidated.includes("radar")) enqueueRadar(pollRadar);
    if (invalidated.includes("loot")) enqueueRadar(pollLootRadar);
    sendResponse({ ok: true, data });
  }, error => {
    sendResponse({ ok: false, error: {
      code: error.code || "INTERNAL_ERROR",
      ...(Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}),
      message: error.code ? error.message : "Extension storage or request failed. Try again."
    } });
  });
  return true;
});

// Invalidate before waiting on the write barrier, but only for authorized,
// validated preference writes. In-flight GETs may finish and cache under their
// original account; obsolete scans stop at the next chunk and cannot publish.
function invalidateScansForWrite(message, sender) {
  if (sender.id !== chrome.runtime.id) return [];
  const popup = sender.url === chrome.runtime.getURL("popup.html");
  const game = /^https:\/\/(app\.)?warera\.io\//.test(sender.url || "");
  const scopes = new Set();
  const nonnegative = value => Number.isFinite(value) && value >= 0;
  const token = message?.token === undefined ? undefined : String(message.token).trim().replace(/^Bearer\s+/i, "");
  if (popup && message?.type === "WE_AGO_FEATURES_SAVE" && message.features && typeof message.features === "object"
    && !Array.isArray(message.features) && Object.entries(message.features).every(([key, value]) => Object.hasOwn(DEFAULT_FEATURES, key) && typeof value === "boolean")) {
    if (message.features.countryBuilds === false) scopes.add("census");
    if ("bountyRadar" in message.features || "contractRadar" in message.features) scopes.add("radar");
    if ("lootRadar" in message.features) scopes.add("loot");
  }
  if (popup && (message?.type === "WE_AGO_CACHE_CLEAR" || message?.type === "WE_AGO_SETTINGS_SAVE"
    && (message.apiProvider === undefined || Object.hasOwn(API_BASES, message.apiProvider))
    && (token === undefined || !/[\r\n]/.test(token) && token.length <= 8192)
    && (message.ttls === undefined || message.ttls && typeof message.ttls === "object" && !Array.isArray(message.ttls)
      && Object.values(message.ttls).every(value => Number.isInteger(value) && value >= 0 && value <= MAX_TTL_SECONDS)))) {
    for (const scope of Object.keys(scanGenerations)) scopes.add(scope);
  }
  if ((popup || game) && message?.type === "WE_AGO_LOOT_RADAR_SAVE" && message.settings
    && [message.settings.legendaryDamage, message.settings.mythicDamage].every(value => value === null || nonnegative(value))) scopes.add("loot");
  if (popup && message?.type === "WE_AGO_RADAR_SAVE" && message.settings
    && nonnegative(message.settings.minimumBounty) && (message.settings.enabled === undefined || typeof message.settings.enabled === "boolean")) scopes.add("radar");
  if ((popup || game) && message?.type === "WE_AGO_RADAR_TRACKING_SAVE"
    && (message.action === "rules" && typeof message.notifyBounty === "boolean" && nonnegative(message.minimumBounty) && Number.isFinite(message.minimumDamageBonus)
      || message.action === "remove" && radarValidId(message.battleId) || message.action === "restore")) scopes.add("radar");
  for (const scope of scopes) scanGenerations[scope]++;
  return [...scopes];
}

// Tokens remain available only to trusted extension contexts, including after restart.
chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});

// Services use the shared transport, write barrier and validated message boundary above.
if (typeof importScripts === "function") importScripts("worker/radar.js", "worker/census.js");
// Serialize maintenance with cache/account writes and drain admitted readers.
void enqueueOperation(restoreCacheSweep).catch(() => {});
