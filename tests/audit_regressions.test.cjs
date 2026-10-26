"use strict";
const assert=require("node:assert/strict"),vm=require("node:vm"),fs=require("node:fs");
const {harness,envelope,ok}=require("./gateway_recovery.test.cjs");
const settle=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
  const h=harness("official",{"we-ago:features":{countryBuilds:true,bountyRadar:false,contractRadar:false,lootRadar:false}}),events=[];
  h.context.chrome.tabs.query=async()=>[{id:1}];h.context.chrome.tabs.sendMessage=async(tab,message)=>events.push({tab,message});
  await h.message({type:"WE_AGO_SETTINGS_SAVE",userId:"b".repeat(24)},true);
  assert(events.some(event=>event.message.type==="WE_AGO_CONTEXT_CHANGED"&&event.message.revision===1&&event.message.playerChanged));
  assert.equal((await h.message({type:"WE_AGO_QUERY",procedure:"itemTrading.getPrices",contextRevision:0})).error.code,"CONTEXT_CHANGED");
  await h.message({type:"WE_AGO_SETTINGS_SAVE",ttls:{default:30}},true);
  assert.equal(events.filter(event=>event.message.type==="WE_AGO_CONTEXT_CHANGED").length,1,"TTL-only saves retain identity context");
  h.respond=()=>ok(envelope({}));
  for(const [procedure,input,requested,expected] of [["tradingOrder.getTopOrders",{itemCode:"steel"},240,120],["region.getById",{regionId:"r"},1200,600]]) {
    const result=await h.message({type:"WE_AGO_QUERY",procedure,input,options:{ttlSeconds:requested}});
    assert.equal((result.data.expiresAt-result.data.createdAt)/1000,expected);
  }
  const c=harness("official",{"we-ago:features":{countryBuilds:true,bountyRadar:false,contractRadar:false,lootRadar:false}});
  let release,entered;const waiting=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),progress=[];
  c.context.chrome.tabs.sendMessage=async(tab,message)=>progress.push({tab,message});
  c.respond=async url=>{
    const names=url.pathname.split("/").pop().split(","),input=JSON.parse(url.searchParams.get("input")),batch=url.searchParams.get("batch")==="1";
    const payload=names.map((name,index)=>envelope(name==="user.getUsersByCountry"?{items:[{_id:"u",level:20,skills:{attack:10,production:0}}]}:{_id:(batch?input[index]:input).userId,skills:{attack:10}}));
    if(names.includes("user.getUsersByCountry")){entered();await waiting;}
    return ok(batch?payload:payload[0]);
  };
  let aggregateWrites=0;const originalSet=c.context.chrome.storage.local.set;
  c.context.chrome.storage.local.set=async values=>{if(Object.values(values).some(value=>value?.procedure==="country.builds"))aggregateWrites++;return originalSet(values);};
  c.context.first={type:"WE_AGO_GET_COUNTRY_BUILDS",countryId:"same",requestId:"first"};
  c.context.second={...c.context.first,requestId:"second",excludeLowLevel:true};
  c.context.sender1={id:"test",url:"https://app.warera.io/country/same",tab:{id:1},frameId:0};
  c.context.sender2={...c.context.sender1,tab:{id:2}};
  const first=vm.runInContext("getCountryBuilds(first,sender1)",c.context);first.catch(()=>{});
  const second=vm.runInContext("getCountryBuilds(second,sender2)",c.context);await started;
  for(let i=0;i<50&&vm.runInContext("[...censusJobs.values()][0].subscribers.size",c.context)<2;i++)await settle();
  assert.equal(vm.runInContext("censusJobs.size",c.context),1);
  await vm.runInContext('handleMessage({type:"WE_AGO_CENSUS_UNSUBSCRIBE",requestId:"first"},sender1)',c.context);release();
  await assert.rejects(first,{code:"SCAN_CANCELLED"});assert.equal((await second).selected.total,1);
  assert.equal(aggregateWrites,1,"coalesced census computes/persists one aggregate");assert(progress.every(event=>event.tab===2));

  const listeners=[],pending=[];const context=vm.createContext({chrome:{runtime:{id:"test",onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:message=>new Promise(resolve=>pending.push({message,resolve}))}}});
  vm.runInContext(fs.readFileSync("content/api.js","utf8"),context);
  listeners[0]({type:"WE_AGO_CONTEXT_CHANGED",revision:4},{id:"test"});pending.shift().resolve({ok:true,data:{revision:1}});
  const late=context.__weAgoApi.send({type:"WE_AGO_QUERY"});late.catch(()=>{});await settle();assert.equal(pending[0].message.contextRevision,4);
  listeners[0]({type:"WE_AGO_CONTEXT_CHANGED",revision:5},{id:"test"});pending.shift().resolve({ok:true,data:{value:"obsolete"}});
  await assert.rejects(late,{code:"CONTEXT_CHANGED"});
  let finishSecond, mapSettled=false; const secondWaiting=new Promise(resolve=>finishSecond=resolve),startedItems=[];
  const map=c.context.__weAgoScans.map([1,2,3],2,async item=>{startedItems.push(item);if(item===1)throw Error("cancel");await secondWaiting;});
  map.catch(()=>{}).finally(()=>{mapSettled=true;});await settle();assert.equal(mapSettled,false,"failed concurrent scans drain already-started reads");
  finishSecond();await assert.rejects(map,/cancel/);assert.deepEqual(startedItems,[1,2]);
  const helper=fs.readFileSync("content/modules/market_undercut.js","utf8");
  assert(!helper.includes("dispatchEvent")&&!helper.includes("setter.call"),"quote actions cannot synthesize native input");
  let apply,timer,healthySync=0,healthyTick=0,healthyDestroy=0,observerStops=0;
  const warnings=[];
  const scheduler=vm.createContext({console:{warn:(...args)=>warnings.push(args)},document:{hidden:false,addEventListener(){},removeEventListener(){}},
    location:{href:"https://app.warera.io/market"},setInterval:fn=>{timer=fn;},clearInterval(){},setTimeout,clearTimeout,
    chrome:{runtime:{id:"test",onMessage:{addListener:fn=>{apply=fn;},removeListener(){}},sendMessage:()=>new Promise(()=>{})}},
    __weAgoRouteObserver:{start:()=>()=>{observerStops++;}},
    __weAgoMarket:{create:()=>({sync(){throw Error("private payload must not be logged");},tick(){throw Error("again");},destroy(){throw Error("cleanup");}})},
    __weAgoBattle:{create:()=>({sync(){healthySync++;},tick(){healthyTick++;},destroy(){healthyDestroy++;}})}});
  vm.runInContext(require("./runtime.cjs").readFileSync("content/main.js","utf8"),scheduler);
  const toggles=Object.fromEntries(scheduler.__weAgoFeatures.map(feature=>[feature.key,["market","battle"].includes(feature.key)]));
  apply({type:"WE_AGO_FEATURES_CHANGED",features:toggles},{id:"test"});timer();
  assert.equal(healthySync,1);assert.equal(healthyTick,1);assert.equal(warnings.length,1);assert(!JSON.stringify(warnings).includes("private"));
  apply({type:"WE_AGO_FEATURES_CHANGED",features:Object.fromEntries(Object.keys(toggles).map(key=>[key,false]))},{id:"test"});
  assert.equal(healthyDestroy,1);assert.equal(observerStops,1,"all-off disconnects discovery despite a throwing cleanup");
  console.log("Audit regressions: context broadcasts/stale replies, TTL limits, coalesced census/subscriber cancellation/progress, startup races and native-input compliance passed.");
})().catch(error=>{console.error(error);process.exitCode=1;});
