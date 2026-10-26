const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const location = { origin: 'https://app.warera.io', href: 'https://app.warera.io/' };
const messages = [], listeners = [];
let requests = 0, payload;
const window = {
  postMessage: message => messages.push(message),
  addEventListener: (_name, listener) => listeners.push(listener),
  fetch: () => { requests++; return Promise.resolve(new Response(JSON.stringify(payload))); }
};
const context = vm.createContext({ window, location, URL, Request, Date, Set, Map, Promise });
vm.runInContext(fs.readFileSync('content/battle_responses.js', 'utf8'), context);

(async () => {
  for (const listener of listeners) listener({source:window,origin:location.origin,data:{channel:'we-ago-battle-read-v1',subscribe:true}});
  const userId = '1'.repeat(24), end = new Date(Date.now() + 120000).toISOString();
  payload = [{ result: { data: { _id: userId, secret: 'must not cross', buffs: {
    buffCodes: ['attack', 'precision'], buffEndAt: end,
    debuffCodes: ['attackPenalty'], debuffEndAt: end
  } } } }];
  const response = await window.fetch('https://api5.warera.io/trpc/user.getUserLite?batch=1', {
    method: 'POST', headers: { authorization: 'must not cross' }, body: JSON.stringify({ 0: { userId } })
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(response.status, 200);
  assert.equal(requests, 1, 'observation sends no additional requests');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].record.buffs.debuffCodes[0], 'attackPenalty');
  assert(!JSON.stringify(messages).includes('must not cross'));

  const source = fs.readFileSync('content/modules/battle.js', 'utf8')
    .replace('return { sync, tick()', 'return { testRender(state) { snapshot = state; mount(); render(); }, sync, tick()')
    .replace('globalThis.__weAgoBattle = { create };', 'globalThis.test = { create, pills, contractRemaining, observedContracts, startObservation };');
  vm.runInContext(source, context);
  context.test.startObservation();
  const now = Date.now(), future = new Date(now + 120000).toISOString();
  const result = context.test.pills([
    { buffs: { buffCodes: ['attack', 'precision'], buffEndAt: future } },
    { buffs: { buffCodes: [], debuffCodes: ['attackPenalty'], debuffEndAt: future } },
    { buffs: { buffCodes: ['pill3'], buffEndAt: new Date(now - 1).toISOString() } },
    { buffs: null }, {}, { buffs: { buffCodes: ['attack'] } }
  ], now);
  assert.equal(result.known, 4);
  assert.equal(result.count, 1, 'count players, not individual effect codes');
  assert.equal(result.debuffed, 1);
  assert.equal(result.ends.length, 1);
  assert.equal(result.ends[0] - now, 120000);
  assert.doesNotThrow(() => context.test.pills([{ buffs: {
    buffCodes: { length: 1 }, debuffCodes: [], buffEndAt: future
  } }], now), 'non-array buff codes cannot invoke array methods');

  const battleId = 'a'.repeat(24), countryId = 'b'.repeat(24);
  const record = { kind: 'contracts', battleId, countryId, receivedAt: now, items: [{
    _id: 'c'.repeat(24), battle: battleId, forCountrySide: 'defender', status: 'active',
    minimumDamage: 1991000, currentDamages: 177357
  }] };
  for (const listener of listeners) listener({ source: window, origin: location.origin,
    data: { channel: 'we-ago-battle-read-v1', record } });
  assert.equal(context.test.observedContracts(battleId, countryId, 'defender').remaining, 1813643);
  assert.equal(context.test.observedContracts(battleId, countryId, 'attacker').remaining, 0);
  assert(source.includes('procedure: "user.getUserById"'));
  assert(!source.includes('"user.getUserLite"'));
  assert(!source.includes('"gameConfig.getGameConfig"'));
  // Exercise the actual render path, including first mount before any response.
  class Element {
    constructor() { this.dataset = {}; this.children = []; this.textContent = ''; }
    append(...children) { this.children.push(...children); }
    setAttribute() {}
    getClientRects() { return [{}]; }
    contains(node) { return node === defender || node === attacker; }
    insertAdjacentElement(_position, panel) { this.nextElementSibling = panel; }
    remove() {}
  }
  const defender = new Element(), attacker = new Element(), row = new Element();
  row.parentElement = new Element(); defender.parentElement = row; attacker.parentElement = row;
  context.document = { body: new Element(), documentElement: new Element(), createElement: () => new Element(),
    getElementById: id => id === 'defender-round-bar' ? defender : id === 'attacker-round-bar' ? attacker : null };
  location.href = location.origin + '/battle/' + 'd'.repeat(24);
  const instance = context.test.create();
  assert.doesNotThrow(() => instance.testRender(undefined), 'initial mount with no snapshot or native round');
  assert.doesNotThrow(() => instance.testRender({ active: true }), 'missing side data');
  assert.doesNotThrow(() => instance.testRender({ active: true, sides: {
    defender: { expiresAt: now + 60000 }, attacker: { expiresAt: now + 60000, profiles: null }
  } }), 'partial side results without profile arrays');
  assert.doesNotThrow(() => instance.testRender({ active: true, sides: {
    defender: { expiresAt: now + 60000, profiles: { filter: null } },
    attacker: { expiresAt: now + 60000, profiles: [{ expiresAt: now + 60000 }] }
  } }), 'malformed collection and missing profile data');
  assert.equal(row.nextElementSibling.children[0].children[0].children[0].textContent, '—');
  assert.doesNotThrow(() => instance.testRender({ active: true, sides: {
    defender: { expiresAt: now + 60000, profiles: [null, { expiresAt: now + 60000, data: { buffs: null } }], total: 1 }
  } }), 'null profile records and absent errors map');
  const rows = row.nextElementSibling.children[0].children;
  assert.equal(rows[0].children[0].textContent, '0');
  assert.equal(rows[0].children[2].textContent, '—');
  instance.testRender({ active: true, battle: { defender: { moneyPool: 100, moneyPer1kDamages: 2 } }, battleExpiresAt: now - 1,
    sides: { defender: { expiresAt: now - 1, total: 1, profiles: [{ expiresAt: now - 1, data: { buffs: { buffCodes: ['attack'], buffEndAt: future } } }] } },
    contracts: { defender: { expiresAt: now - 1, remaining: 1200 } } });
  assert.equal(rows[0].children[0].textContent, '1', 'last known profiles stay visible after cache expiry');
  assert.notEqual(rows[2].children[0].textContent, '—', 'last known contract damage stays visible');
  assert.notEqual(rows[3].children[0].textContent, '—', 'last known bounty stays visible');
  instance.destroy();
  // Run sync -> asynchronous worker reads -> progressive rendering, rather
  // than checking only injected snapshots. No native responses are required.
  let workerCalls = 0, batchMode = 'ok', singletonProfiles = 0;
  const profileInputs = [], rankingInputs = [];
  const roundId = 'e'.repeat(24), activeBattleId = 'd'.repeat(24);
  context.chrome = { runtime: { sendMessage: async message => {
    workerCalls++;
    if (message.procedure === 'user.getUserById') singletonProfiles++;
    if (message.type === 'WE_AGO_BATCH' && batchMode === 'outage') return { ok: false, error: { code: 'HTTP_ERROR', message: 'Rate limited' } };
    if (message.type === 'WE_AGO_BATCH') profileInputs.push(...message.calls.map(call => call.input.userId));
    if (message.procedure === 'battleRanking.getRanking') rankingInputs.push(message.input);
    const data = message.type === 'WE_AGO_BATCH' ? message.calls.map(call => ({
      data: { _id: call.input.userId, buffs: { buffCodes: ['attack'], buffEndAt: future } },
      createdAt: now, expiresAt: now + 60000
    })) : { data: message.procedure === 'battle.getLiveBattleData' ? { round: { roundId, isActive: true } }
      : message.procedure === 'battle.getById' ? { _id: activeBattleId, isActive: true,
        defender: { country: countryId, moneyPool: 0 }, attacker: { country: countryId, moneyPool: 0 } }
      : message.procedure === 'battleRanking.getRanking' ? message.input.cursor
        ? { items: [{ _id: '8'.repeat(24), user: { _id: '2'.repeat(24) }, value: 50 }], itemCount: 2 }
        : { items: [{ _id: '9'.repeat(24), user: userId, value: 100 }], nextCursor: 'page2', itemCount: 2 }
      : {},
      createdAt: now, expiresAt: now + 60000 };
    return { ok: true, data: message.type === 'WE_AGO_BATCH' && batchMode === 'partial'
      ? data.map((result, index) => index === 0 ? { ok: true, result } : { ok: false, error: { code: 'HTTP_ERROR', httpStatus: 403 } }) : data };
  } } };
  const live = context.test.create();
  assert.doesNotThrow(() => live.sync());
  await new Promise(resolve => setTimeout(resolve, 20));
  assert(workerCalls >= 5, 'full worker/profile load completed');
  assert.doesNotThrow(() => live.sync());
  assert.equal(row.nextElementSibling.children[0].children[0].children[0].textContent, '2');
  assert.equal(profileInputs.length, 2, 'one profile lookup per player shared across sides');
  assert(profileInputs.includes(userId));
  assert(profileInputs.includes('2'.repeat(24)));
  assert(!profileInputs.includes('9'.repeat(24)), 'ranking document ID must not be queried as a user');
  assert.equal(rankingInputs.filter(input => input.cursor === 'page2').length, 2);
  live.destroy();
  batchMode = 'partial';
  const partial = context.test.create(); partial.sync(); await new Promise(resolve => setTimeout(resolve, 20));
  assert(row.nextElementSibling.children[0].children[0].children[0].textContent.includes('1'), 'healthy profile remains visible in a partially failed batch');
  partial.destroy();
  batchMode = 'outage';
  const outage = context.test.create(); outage.sync(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(singletonProfiles, 0, 'neither isolated errors nor shared outages fan out into profile retries');
  outage.destroy();
  console.log('PASS: capture, buff/debuff metrics, contracts, initial/partial rendering, full async sync/load/render');
})().catch(error => { console.error(error); process.exitCode = 1; });
