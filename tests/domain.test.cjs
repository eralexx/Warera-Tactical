"use strict";
const assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs");
const context = vm.createContext({});
vm.runInContext(fs.readFileSync("shared/domain.js", "utf8"), context);
const domain = context.__weAgoDomain;
for (const key of ["criticalDamage", "criticalDamages"]) {
  assert.equal(domain.classify({ skills: { attack: 10, production: 10, [key]: 100 } }).build, "damage");
}
assert.equal(domain.classify({ skills: { criticalDamage: 65, criticalDamages: 100, production: 35 } }).combatScore, 65);
for (const [attack, production, build] of [[35,65,"eco"],[65,35,"damage"],[36,64,"hybrid"],[0,0,"unallocated"]]) {
  assert.equal(domain.classify({skills:{attack,production}}).build, build);
}
assert.equal(domain.investment({level:15,baseLevel:5}),10);
assert.equal(domain.classify({}),null);
assert.throws(()=>domain.classify({skills:{attack:{}}}),{code:"UNKNOWN_SKILLS"});
assert.equal(domain.skill({criticalDamages:42},"criticalDamage"),42);
console.log("Shared domain aliases, precedence, legacy investment, malformed input and classification boundaries passed.");
