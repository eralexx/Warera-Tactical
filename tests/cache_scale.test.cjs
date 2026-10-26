"use strict";
const fs=require("node:fs"),vm=require("node:vm"),assert=require("node:assert/strict");
const {performance}=require("node:perf_hooks");
const context=vm.createContext({TextEncoder,Date});vm.runInContext(fs.readFileSync("shared/cache.js","utf8"),context);
(async()=>{
  const measurements=[];
  for(const count of [100,1000,10000]) {
    const stored={"we-ago:settings":{token:"dummy-only"}},reads=[];
    for(let i=0;i<count;i++)stored["we-ago:cache:"+String(i).padStart(6,"0")]={createdAt:i,expiresAt:Date.now()+60000,data:"x".repeat(2048)};
    const storage={getKeys:async()=>Object.keys(stored),async get(keys){const chosen=keys===null?Object.keys(stored):Array.isArray(keys)?keys:[keys];reads.push(chosen.length);return JSON.parse(JSON.stringify(Object.fromEntries(chosen.filter(key=>stored[key]).map(key=>[key,stored[key]]))));},async set(values){Object.assign(stored,values);},async remove(keys){for(const key of keys)delete stored[key];}};
    const cache=context.__weAgoCache.create(storage,"we-ago:cache:");
    const before=performance.now();await storage.get(null);const oldMs=performance.now()-before;reads.length=0;
    const start=performance.now(),page=await cache.page(0,50),pageMs=performance.now()-start;
    assert.equal(page.entries.length,50);assert.equal(page.total,count);assert.equal(Math.max(...reads),50);
    const maxPayloadKeys=Math.max(...reads);reads.length=0;await cache.clear();assert.equal(reads.length,0);assert.equal(stored["we-ago:settings"].token,"dummy-only");
    measurements.push({entries:count,oldPayloadKeys:count+1,pagePayloadKeys:maxPayloadKeys,clearPayloadKeys:0,oldMs:+oldMs.toFixed(2),pageMs:+pageMs.toFixed(2)});
  }
  console.log("Cache synthetic measurements:",JSON.stringify(measurements));
})().catch(error=>{console.error(error);process.exitCode=1;});
