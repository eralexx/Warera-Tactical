"use strict";

const assert = require("node:assert/strict");
const fs = require("./runtime.cjs");
const vm = require("node:vm");
const ids = ["a", "b", "c", "d"].map(char => char.repeat(24));
const listeners = new Map();
const nodes = [];
const heading = { textContent: "Wage", matches: () => false,
  after(node) { node.remove(); this.nextSibling = node; node.host = this; } };
const label = { children: [heading] };
const selection = { value: ids[0] };
const form = { querySelector: () => selection };
const input = { value: "0.168", isConnected: true, after: heading.after,
  closest(selector) { return selector === "form" ? form : selector === "label" ? label : null; } };
const document = {
  hidden: false,
  querySelectorAll: () => input.isConnected ? [input] : [],
  createElement() {
    const node = { dataset: {}, textContent: "", remove() {
      if (this.host?.nextSibling === this) this.host.nextSibling = null;
      this.host = null;
    } };
    nodes.push(node); return node;
  },
  addEventListener(name, callback) { listeners.set(name, callback); },
  removeEventListener(name, callback) { assert.equal(listeners.get(name), callback); listeners.delete(name); }
};
const calls = [];
let tax = 7;
let fail = false;
let delayed;
let clock = 1000;
const context = vm.createContext({ document, location: { pathname: "/companies" },
  __weAgoUi: { money(host, value, suffix) { assert.equal(suffix, "/PP"); host.textContent = value; } },
  Date: { now: () => clock }, chrome: { runtime: { async sendMessage(request) {
    calls.push(request);
    if (delayed) { const wait = delayed; delayed = null; await wait; }
    if (fail) return { ok: false, error: { code: "TOKEN_MISSING" } };
    const data = request.procedure === "company.getById" ? { _id: request.input.companyId, region: ids[1] }
      : request.procedure === "region.getById" ? { _id: ids[1], country: ids[2] }
        : { _id: ids[2], name: "Testland", taxes: { income: tax } };
    return { ok: true, data: { data: { json: data }, expiresAt: clock + request.options.ttlSeconds * 1000 } };
  } } }
});
vm.runInContext(fs.readFileSync(require("node:path").join(__dirname, "../content/modules/net_salary.js"), "utf8"), context);
const api = context.__weAgoNetSalary;
const settle = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  assert.ok(Math.abs(api.netSalary(1, 7) - 0.93) < 1e-12);
  assert.equal(api.netSalary(0, 7), 0);
  assert.equal(api.netSalary(1, 0), 1);
  assert.equal(api.netSalary(1, 100), 0);
  for (const invalid of [null, undefined, "7", NaN, Infinity, -1, 101]) assert.equal(api.netSalary(1, invalid), null);
  const instance = api.create();
  instance.sync(); await settle();
  assert.equal(input.nextSibling.textContent, "Net 0.156");
  assert.match(input.nextSibling.title, /7%.*Testland/);
  assert.equal(input.nextSibling.dataset.weAgo, "true");
  assert.equal(heading.textContent, "Wage");
  assert.equal(input.value, "0.168");
  assert.deepEqual(calls.map(call => call.options.ttlSeconds), [120, 600, 600]);
  instance.sync(); assert.equal(calls.length, 3);
  for (const [value, expected] of [[".5", "Net 0.465"], ["0,2", "Net 0.186"], ["0", "Net 0.000"], ["", "Net —"], ["-1", "Net —"]]) {
    input.value = value;
    listeners.get("input")({ target: { matches: () => true } });
    assert.equal(input.nextSibling.textContent, expected);
  }
  input.value = "0.168";
  // Changing the company while a lookup is pending must discard the old response.
  let release;
  delayed = new Promise(resolve => { release = resolve; });
  selection.value = ids[3]; instance.sync();
  selection.value = ids[0]; instance.sync(); await settle();
  const current = input.nextSibling;
  release(); await settle();
  assert.equal(input.nextSibling, current);
  assert.equal(current.textContent, "Net 0.156");
  // Last known tax stays visible during delayed refresh and failures; retries back off.
  clock += 121000; fail = true;
  delayed = new Promise(resolve => { release = resolve; });
  instance.sync();
  assert.equal(current.textContent, "Net 0.156", "last known tax remains visible while refreshing");
  release(); await settle();
  assert.equal(current.textContent, "Net 0.156");
  assert.match(current.title, /Set API token/);
  const count = calls.length; instance.sync(); assert.equal(calls.length, count);
  clock += 30001; fail = false; tax = undefined;
  instance.sync(); await settle(); assert.equal(current.textContent, "Net 0.156");
  assert.match(current.title, /Last known.*Income tax unavailable/);
  clock += 30001; tax = 0;
  instance.sync(); await settle(); assert.equal(current.textContent, "Net 0.168");
  // The SPA can remove just our badge or replace the entire form.
  current.remove(); instance.sync(); assert.equal(input.nextSibling, current);
  input.isConnected = false; instance.sync(); assert.equal(input.nextSibling, null);
  input.isConnected = true; instance.sync(); await settle();
  assert.equal(input.nextSibling.textContent, "Net 0.168");
  instance.destroy(); assert.equal(input.nextSibling, null); assert.equal(listeners.size, 0);
  assert.equal(heading.textContent, "Wage");
  console.log("Net salary: arithmetic, edits, caching, stale responses, errors, remount and teardown passed");
})().catch(error => { console.error(error); process.exitCode = 1; });

