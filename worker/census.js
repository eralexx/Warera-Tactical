"use strict";

// T010: census snapshots share the account/provider cache namespace and transport.
const COUNTRY_BUILDS_TTL = 1800000;
const countryUnwrap = value => value && Object.hasOwn(value, "json") ? value.json : value;
const countryUserId = value => typeof value === "string" ? value : value?._id ?? value?.id ?? value?.userId;

function countryInvestment(skill) { return globalThis.__weAgoDomain.investment(skill); }
function countryClassify(user) { return globalThis.__weAgoDomain.classify(user); }

function countryBreakdown(citizens) {
  const counts = { eco: 0, damage: 0, hybrid: 0, unallocated: 0, unknown: 0 };
  for (const citizen of citizens) counts[citizen.build]++;
  const classified = counts.eco + counts.damage + counts.hybrid;
  const levels = citizens.map(user => user.level).filter(Number.isFinite).sort((a, b) => a - b);
  const mid = Math.floor(levels.length / 2);
  return { ...counts, total: citizens.length, classified,
    ecoPct: classified ? counts.eco / classified * 100 : 0,
    damagePct: classified ? counts.damage / classified * 100 : 0,
    hybridPct: classified ? counts.hybrid / classified * 100 : 0,
    medianLevel: !levels.length ? null : levels.length % 2 ? levels[mid] : (levels[mid - 1] + levels[mid]) / 2 };
}

const censusJobs = new Map(), cancelledSubscribers = new Map();
const censusSubscriberKey = (sender, requestId) => JSON.stringify([sender.tab?.id, sender.frameId, requestId]);
async function getCountryBuilds(message, sender, check = makeScanCheck("census")) {
  if ([message.forceRefresh, message.excludeLowLevel].some(value => value !== undefined && typeof value !== "boolean")) throw failure("INVALID_INPUT", "Invalid country scan input.");
  const settings = await readSettings();
  const key = await digest(canonicalJson([settings.token, settings.apiProvider, message.type, message.countryId ?? message.muId, !!message.forceRefresh, scanGenerations.census]));
  check();
  if (cancelledSubscribers.has(censusSubscriberKey(sender,message.requestId)) && Date.now() - cancelledSubscribers.get(censusSubscriberKey(sender,message.requestId)) < 60000) throw failure("SCAN_CANCELLED", "Scan subscriber cancelled.");
  let job = censusJobs.get(key);
  if (!job) {
    job = { subscribers: new Set() }; censusJobs.set(key, job);
    job.promise = Promise.resolve().then(() => scanCountryBuilds({...message,excludeLowLevel:false}, sender, () => {check(); if (!job.subscribers.size) throw failure("SCAN_CANCELLED", "Scan has no subscribers.");}, job.subscribers))
      .finally(() => censusJobs.delete(key));
  }
  const subscriber = {sender,requestId:message.requestId}; job.subscribers.add(subscriber);
  try { const data = await job.promise; check(); if (!job.subscribers.has(subscriber)) throw failure("SCAN_CANCELLED", "Scan subscriber cancelled."); return {...data, selected:message.excludeLowLevel ? data.veterans : data.all}; }
  finally { job.subscribers.delete(subscriber); }
}
async function scanCountryBuilds(message, sender, check, subscribers) {
  const scope = message.type === "WE_AGO_GET_MU_BUILDS" ? "mu" : "country";
  const countryId = scope === "mu" ? message.muId : message.countryId;
  if (typeof countryId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(countryId)
    || [message.forceRefresh, message.excludeLowLevel].some(value => value !== undefined && typeof value !== "boolean")) {
    throw failure("INVALID_INPUT", "Invalid country scan input.");
  }
  check();
  if (!(await readFeatures()).countryBuilds) throw failure("FEATURE_DISABLED", "Build summary is disabled.");
  const settings = await readSettings();
  if (!settings.token) throw failure("TOKEN_MISSING", "Save an API token in the extension popup.");
  const key = CACHE_PREFIX + await digest(await digest(settings.token) + ":" + settings.apiProvider + `:${scope}-builds-v1:` + countryId);
  const cached = (await chrome.storage.local.get(key))[key];
  check();
  const select = summary => ({ ...summary, selected: message.excludeLowLevel ? summary.veterans : summary.all });
  const now = Date.now();
  if (cached?.createdAt <= now && (cached.expiresAt > now && !message.forceRefresh || message.forceRefresh && now - cached.createdAt < 60000)) {
    return select({ ...cached.data, cached: true });
  }
  const client = new WarEraClient(settings, check);
  const options = { forceRefresh: message.forceRefresh === true, ttlSeconds: 1800 };
  const users = new Map(), cursors = new Set();
  if (scope === "mu") {
    const unit = countryUnwrap((await client.query("mu.getById", { muId: countryId }, options)).data);
    if ((unit?._id ?? unit?.id) !== countryId || !Array.isArray(unit.members)) throw failure("INVALID_RESPONSE", "MU member list unavailable.");
    for (const entry of unit.members) {
      const user = entry?.user && typeof entry.user === "object" ? entry.user : entry;
      const id = countryUserId(user);
      if (typeof id !== "string" || !id) throw failure("INVALID_RESPONSE", "Member identifier missing.");
      users.set(id, { ...(typeof user === "object" ? user : {}), _id: id });
    }
  }
  let cursor;
  if (scope === "country") do {
    const page = countryUnwrap((await client.query("user.getUsersByCountry", { countryId, limit: 100, ...(cursor ? { cursor } : {}) }, options)).data);
    const items = Array.isArray(page) ? page : page?.items ?? page?.users;
    if (!Array.isArray(items)) throw failure("INVALID_RESPONSE", "Country citizen list unavailable.");
    for (const entry of items) {
      const user = entry?.user && typeof entry.user === "object" ? entry.user : entry;
      const id = countryUserId(user);
      if (typeof id !== "string" || !id) throw failure("INVALID_RESPONSE", "Citizen identifier missing.");
      users.set(id, { ...(users.get(id) || {}), ...(typeof user === "object" ? user : {}), _id: id });
    }
    cursor = page?.nextCursor ?? page?.cursor;
    if (cursor != null && cursor !== "") {
      if (typeof cursor !== "string" || cursors.has(cursor)) throw failure("INVALID_RESPONSE", "Country pagination did not advance.");
      cursors.add(cursor);
    }
  } while (cursor);
  const active = user => !user.infos?.isBanned && user.isActive !== false && user.infos?.isActive !== false;
  const citizens = [...users.values()].filter(active);
  const missing = citizens.filter(user => !user.skills || typeof user.skills !== "object" || !Object.keys(user.skills).length);
  let scanned = citizens.length - missing.length;
  const progress = async () => {
    check();
    const targets = [...subscribers].filter(subscriber => Number.isInteger(subscriber.sender.tab?.id));
    const delivered = await Promise.allSettled(targets.map(subscriber =>
      chrome.tabs.sendMessage(subscriber.sender.tab.id, {type:"WE_AGO_COUNTRY_SCAN_PROGRESS",countryId,scope,requestId:subscriber.requestId,scanned,total:citizens.length}, {frameId:subscriber.sender.frameId ?? 0})));
    delivered.forEach((outcome,index) => { if (outcome.status === "rejected") subscribers.delete(targets[index]); });
  };
  await progress();
  for (let offset = 0; offset < missing.length; offset += 25) {
    check();
    if (offset) await new Promise(resolve => setTimeout(resolve, 150));
    const chunk = missing.slice(offset, offset + 25);
    // Share live profiles with readiness, timelines, battle pills and the HUD.
    // Only the derived build snapshot uses the longer census lifetime.
    const results = await client.batch(chunk.map(user => ({ procedure: "user.getUserById", input: { userId: user._id }, ttlSeconds: 120 })), options);
    results.forEach((result, index) => {
      const profile = countryUnwrap(result.data);
      const user = profile?.user ?? profile;
      if (!user || typeof user !== "object" || (countryUserId(user) && countryUserId(user) !== chunk[index]._id)) {
        throw failure("INVALID_RESPONSE", "Citizen profile mismatch.");
      }
      Object.assign(chunk[index], user, { infos: { ...chunk[index].infos, ...user.infos } });
    });
    scanned += chunk.length;
    await progress();
  }
  const records = citizens.filter(active).map(user => {
    const level = user.level?.level ?? user.level ?? user.leveling?.level;
    return { id: user._id, username: typeof user.username === "string" ? user.username : user._id,
      level: typeof level === "number" && Number.isFinite(level) ? level : null,
      ...(countryClassify(user) || { build: "unknown", combatShare: null }) };
  });
  const createdAt = Date.now();
  check();
  const data = { countryId, scope, createdAt, expiresAt: createdAt + COUNTRY_BUILDS_TTL, citizens: records,
    all: countryBreakdown(records), veterans: countryBreakdown(records.filter(user => user.level >= 15)), cached: false };
  data.cachePersisted = await writeResponseCache({ [key]: { procedure: scope + ".builds", provider: settings.apiProvider, createdAt, expiresAt: data.expiresAt, data } });
  check();
  return select(data);
}

