"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm");
const context=vm.createContext({Date,TextEncoder});vm.runInContext(fs.readFileSync("shared/cache.js","utf8"),context);
const {harness:workerHarness,query}=require("./gateway_recovery.test.cjs");
function harness(count=150) {
  const stored={"we-ago:settings":{token:"dummy"}},reads=[];
  for(let i=0;i<count;i++)stored["we-ago:cache:"+String(i).padStart(4,"0")]={createdAt:0,expiresAt:Date.now()-1,data:i};
  const storage={getKeys:async()=>Object.keys(stored),async get(keys){const selected=Array.isArray(keys)?keys:[keys];reads.push(selected);return Object.fromEntries(selected.map(key=>[key,stored[key]]));},async set(values){Object.assign(stored,values);},async remove(keys){for(const key of keys)delete stored[key];}};
  return {stored,storage,reads,cache:context.__weAgoCache.create(storage,"we-ago:cache:")};
}
(async()=>{
  const h=harness();assert.equal((await h.cache.page(100)).offset,100);
  for(let i=50;i<150;i++)delete h.stored["we-ago:cache:"+String(i).padStart(4,"0")];
  const page=await h.cache.page(100);assert.equal(page.offset,0);assert.equal(page.total,50);assert.equal(page.entries.length,50);
  await h.cache.clear();assert.equal((await h.cache.page(100)).offset,0);
  for(const cursor of [-1,"broken",{},Infinity,999999]) {
    const h=harness();h.stored["we-ago:cacheSweep"]=cursor;
    assert.equal(await h.cache.prune(),100,"bad or obsolete sweep cursors restart a bounded sweep");
    assert(h.reads.every(keys=>keys.length<=100));assert.equal(h.stored["we-ago:settings"].token,"dummy");
  }
  const worker=workerHarness("official"),alarms=new Map();let created=0;
  worker.context.chrome.alarms.get=async name=>alarms.get(name);
  worker.context.chrome.alarms.create=async(name,value)=>{created++;alarms.set(name,value);};
  worker.context.chrome.alarms.clear=async name=>alarms.delete(name);
  const flush=async()=>{for(let i=0;i<3;i++){await vm.runInContext("queue",worker.context);await vm.runInContext("radarQueue",worker.context);await new Promise(resolve=>setImmediate(resolve));}};
  await flush();assert(!alarms.has("we-ago-cache-sweep"),"empty cache does not schedule periodic wakeups");
  assert((await worker.message(query())).ok);assert(alarms.has("we-ago-cache-sweep"));assert.equal(created,1);
  await worker.message(query());assert.equal(created,1,"cache hits do not reschedule maintenance");
  await worker.message({type:"WE_AGO_CACHE_CLEAR"},true);assert(!alarms.has("we-ago-cache-sweep"));
  await worker.message(query());assert.equal(created,2,"new cached reads resume maintenance");
  worker.advance(121000);await vm.runInContext("enqueueOperation(runCacheSweep)",worker.context);
  assert(!alarms.has("we-ago-cache-sweep"),"final expiry stops maintenance wakeups");
  worker.context.chrome.alarms.get=async()=>{throw Error("alarm unavailable");};
  assert((await worker.message(query())).ok,"alarm failures cannot discard healthy API reads");
  console.log("Cache lifecycle: shrinking/empty pages recover, malformed sweep cursors reset and bounded cleanup preserves preferences.");
})().catch(error=>{console.error(error);process.exitCode=1;});
