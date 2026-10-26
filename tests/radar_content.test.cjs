"use strict";
const fs = require("./runtime.cjs"), os = require("node:os"), path = require("node:path");
const assert = require("node:assert/strict"), { spawnSync } = require("./browser.cjs");
const { pathToFileURL } = require("node:url");
const root = path.join(__dirname, "..");
const chrome = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
if (!fs.existsSync(chrome)) throw Error("Set CHROME_PATH to run radar browser checks.");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "warera-radar-"));
const fixture = path.join(directory, "fixture.html");
const styles = fs.readFileSync(path.join(root, "content/styles.css"), "utf8");
const modules = fs.readFileSync(path.join(root, "content/ui.js"), "utf8") + "\n" + ["bounty_radar.js", "loot_radar.js"].map(file => fs.readFileSync(path.join(root, "content/modules", file), "utf8")).join("\n");
const setup = `
const listeners = new Set(), requests = [], calls = [];
let delayRadar = false, delayLoot = false;
let now = Date.now(); Date.now = () => now;
const pref = {settings:{enabled:true,contractsEnabled:true,notifyBounty:true,minimumBounty:2,minimumDamageBonus:20},tracking:{removedBattleIds:[],notifyBattleIds:[],open:true}};
const alerts = [
 {type:'CLOSING_SOON',battleId:'closing',roundNumber:2,regionName:'Paris',side:'attacker',terrain:275,ticksLeft:2},
 {type:'HIGH_BOUNTY',battleId:'bounty',roundNumber:2,regionName:'Bavaria',side:'defender',rate:2.5,budget:1000,damageBonusPercent:35},
 {type:'CONTRACT',battleId:'contract',contractId:'auction',roundNumber:2,regionName:'Lombardy',side:'attacker',rate:3,budget:1500,damageBonusPercent:40,minimumDamage:500000,professionalsOnly:true}
];
const loot = {settings:{legendaryDamage:600000,mythicDamage:1000000},items:[
 {targetId:'gold',battleId:'closing',regionName:'Paris',scope:'round',roundNumber:2,side:'merged',rank:3,itemCode:'tank',rarity:'legendary',damage:450001,roundEstimate:{endsAt:now+3661000,observedAt:now}},
 {targetId:'red',battleId:'bounty',regionName:'Bavaria',scope:'battle',roundNumber:2,side:'merged',rank:1,itemCode:'jet',rarity:'mythic',damage:900001}
],syncedAt:Date.now(),issue:''};
const stored = {};
window.chrome = {storage:{local:{get:async key=>({[key]:stored[key]}),set:async value=>Object.assign(stored,value)}},runtime:{id:'fixture',onMessage:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},sendMessage:async m=>{
 calls.push(m.type);
 if(m.type==='WE_AGO_RADAR_POSITION_GET')return{ok:true,data:stored['we-ago:radar-position']};
 if(m.type==='WE_AGO_RADAR_POSITION_SAVE'){stored['we-ago:radar-position']=m.position;return{ok:true,data:m.position};}
 if(m.type==='WE_AGO_RADAR_GET'){if(delayRadar)return new Promise(resolve=>requests.push(()=>resolve({ok:true,data:{...pref,activeAlerts:alerts}})));return{ok:true,data:structuredClone({...pref,activeAlerts:alerts})};}
 if(m.type==='WE_AGO_LOOT_RADAR_GET'){if(delayLoot)return new Promise(resolve=>requests.push(()=>resolve({ok:true,data:loot})));return{ok:true,data:structuredClone(loot)};}
 if(m.type==='WE_AGO_LOOT_RADAR_SAVE'){loot.settings=m.settings;return{ok:true,data:structuredClone(loot)};}
 if(m.action==='remove')pref.tracking.removedBattleIds.push(m.battleId);
 if(m.action==='restore')pref.tracking.removedBattleIds=[];
 if(m.action==='notify')pref.tracking.notifyBattleIds=m.enabled?[m.battleId]:[];
 if(m.action==='open')pref.tracking.open=m.open;
 if(m.action==='rules')Object.assign(pref.settings,m);
 return{ok:true,data:structuredClone(pref)};
}}};
`;
async function checks() {
 const settle = () => new Promise(resolve => setTimeout(resolve, 30));
 const check = (condition, name) => { if(!condition)throw Error(name); };
 const click = selector => {const node=document.querySelector(selector);check(node?.dataset.weAgo==='true','only extension-owned controls');node.click();};
 let bounty=__weAgoBountyRadar.create(),contract=__weAgoContractRadar.create(),items=__weAgoLootRadar.create();
 await settle();
 check(!document.querySelector('.we-ago-loot-countdown'),'countdown waits for its independent flag');
 let timer=__weAgoLootRoundTimer.create();
 const firstCountdown=document.querySelector('.we-ago-loot-countdown');
 check(firstCountdown.textContent==='Round ≈ 01:01:01','countdown formats hours minutes seconds');
 check([...document.querySelectorAll('.we-ago-loot-countdown')][1].textContent==='Round ETA —','unknown timing is not zero');
 now+=1000;timer.tick();
 check(firstCountdown===document.querySelector('.we-ago-loot-countdown')&&firstCountdown.textContent==='Round ≈ 01:01:00','tick updates in place');
 const readCount=calls.length;
 timer.destroy();
 check(!document.querySelector('.we-ago-loot-countdown')&&document.querySelectorAll('.we-ago-loot-result').length===2,'timer off preserves loot');
 timer=__weAgoLootRoundTimer.create();timer.tick();
 check(document.querySelectorAll('.we-ago-loot-countdown').length===2&&calls.length===readCount,'timer re-enables without requests');
 now+=120000;timer.tick();
 check(firstCountdown.textContent==='Round ≈ 01:01:00','disabled countdown node stays detached');
 check(document.querySelector('.we-ago-loot-countdown').textContent==='Round updating…','stale forecast stops counting');
 const radar=()=>document.getElementById('we-ago-bounty-radar');
 const lootRoot=()=>document.getElementById('we-ago-loot-radar');
 check(radar().getBoundingClientRect().left===12&&radar().getBoundingClientRect().top===12,'default top-left position');
 const summary=radar().querySelector('summary');
 check(summary.textContent.startsWith('Warera UI Enhancer - Radar'),'branded radar prefix');
 const initialOpen=radar().open;
 const pointer=(type,x,y)=>summary.dispatchEvent(new PointerEvent(type,{pointerId:1,isPrimary:true,button:0,clientX:x,clientY:y,bubbles:true}));
 pointer('pointerdown',30,25);pointer('pointermove',50,100);pointer('pointerup',50,100);
 summary.click();
 check(radar().open===initialOpen,'drag does not toggle disclosure');
 check(radar().getBoundingClientRect().top===87,'title drag moves panel');
 check(stored['we-ago:radar-position'].top===87,'drag saves position');
 summary.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
 check(radar().getBoundingClientRect().top===97,'keyboard movement');
 pointer('pointerdown',50,100);pointer('pointermove',5000,5000);pointer('pointerup',5000,5000);
 const movedBox=radar().getBoundingClientRect();
 check(movedBox.right<=innerWidth-11&&movedBox.bottom<=innerHeight,'drag keeps panel in viewport');
 pointer('pointerdown',5000,5000);pointer('pointermove',-5000,-5000);pointer('pointerup',-5000,-5000);
 summary.click();
 check(radar().getBoundingClientRect().top===12&&radar().getBoundingClientRect().left===12,'drag clamps top-left');
 summary.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
 check(document.querySelectorAll('#we-ago-bounty-radar').length===1,'single shared radar view');
 check(radar().querySelectorAll('.we-ago-radar-row').length===2,'closing alerts ignored; bounty and contract rows remain');
 check(!radar().querySelector('.we-ago-radar-notify'),'individual Notify controls removed');
 check(radar().querySelector('[data-kind=bounty] .we-ago-radar-value').textContent.trim()==='Available '+(1000).toLocaleString(),'available bounty amount displayed');
 check(radar().querySelector('[data-kind=contract] .we-ago-radar-value').textContent.trim()==='Available '+(1500).toLocaleString(),'available contract amount displayed');
 check(radar().querySelector('[data-kind=contract]').textContent.includes('MU auction'),'auction label and restrictions');
 const firstRow=radar().querySelector('.we-ago-radar-row'), firstButton=firstRow.querySelector('button');
 firstButton.focus();
 for(const listener of listeners)listener({type:'WE_AGO_RADAR_UPDATE',payload:structuredClone(alerts)},{id:'fixture'});
 check(radar().querySelector('.we-ago-radar-row')===firstRow&&document.activeElement===firstButton,'unchanged refresh preserves row and keyboard focus');
 check(radar().querySelector('.we-ago-radar-opportunities').firstElementChild.tagName!=='FORM','results precede filters');
 const rules=radar().querySelector('form');rules.elements.bonus.value='-20';
 check(rules.elements.bonus.checkValidity(),'negative bonus is a valid form value');
 rules.requestSubmit();await settle();check(pref.settings.minimumDamageBonus===-20,'negative bonus saves numerically');
 const update={type:'WE_AGO_RADAR_UPDATE',payload:[{type:'HIGH_BOUNTY',battleId:'negative',roundNumber:1,regionName:'Debuff',side:'attacker',rate:0.05,budget:100,damageBonusPercent:-20}]};
 for(const listener of listeners)listener(update,{id:'fixture'});
 check(radar().querySelector('[data-kind=bounty]').textContent.includes(' · -20% damage'),'negative bonus has no extra plus sign');
 bounty.destroy();contract.destroy();bounty=__weAgoBountyRadar.create();contract=__weAgoContractRadar.create();await settle();
 check(radar().querySelector('form').elements.bonus.value==='-20','negative bonus restores on re-enable');
 bounty.destroy();await settle();
 check(radar().querySelectorAll('.we-ago-radar-row').length===1,'bounty off preserves contract-only radar');
 check(radar().querySelector('[data-kind=contract]'),'contract remains enabled');
 contract.destroy();await settle();check(radar()&&lootRoot(),'loot-only keeps shared shell');check(!radar().querySelector('.we-ago-radar-opportunities'),'opportunity section removed');check(listeners.size===1,'radar listeners cleaned without disabling loot');
 delayRadar=true;const late=__weAgoContractRadar.create();late.destroy();requests.splice(0).forEach(resolve=>resolve());await settle();
 check(!radar().querySelector('.we-ago-radar-opportunities'),'late radar response cannot resurrect section');delayRadar=false;
 items.destroy();check(!lootRoot()&&!radar(),'last feature destroys shared shell');check(listeners.size===0,'all listeners cleaned');
 delayLoot=true;const lateLoot=__weAgoLootRadar.create();lateLoot.destroy();requests.splice(0).forEach(resolve=>resolve());await settle();
 check(!lootRoot()&&!radar(),'late loot response ignored');delayLoot=false;
 bounty=__weAgoBountyRadar.create();contract=__weAgoContractRadar.create();items=__weAgoLootRadar.create();await settle();
 check(radar().querySelectorAll('.we-ago-radar-row').length===2,'re-enable without reload');
 click('[data-kind=contract] .we-ago-radar-remove');await settle();check(!radar().querySelector('[data-kind=contract]'),'removed battle hidden');
 click('.we-ago-radar-restore');await settle();check(radar().querySelector('[data-kind=contract]'),'restore removed contract');
 check(lootRoot().closest('#we-ago-bounty-radar')===radar(),'loot integrated in radar');
 now += 121000; bounty.tick(); items.tick();
 check(radar().querySelectorAll('.we-ago-radar-row').length===2,'last known radar opportunities survive TTL');
 check(lootRoot().querySelectorAll('.we-ago-loot-result').length===2,'last known loot targets survive TTL');
 check(document.querySelectorAll('#we-ago-bounty-radar').length===1,'one dropdown for every radar feature');
 check(radar().querySelector('summary').textContent.includes('4'),'shared total includes loot targets');
 check(lootRoot().querySelectorAll('.we-ago-loot-result').length===2,'gold and red loot targets');
 check([...lootRoot().querySelectorAll('.we-ago-loot-offer')].every(node=>node.textContent.includes('Both sides')),'combined-damage scope displayed');
 check([...lootRoot().querySelectorAll('a')].every(node=>node.getAttribute('href').startsWith('/battle/')),'loot links only navigate to battles');
 const form=lootRoot().querySelector('form');form.elements.legendary.value='550000';form.elements.mythic.value='950000';form.requestSubmit();await settle();
 check(loot.settings.legendaryDamage===550000&&loot.settings.mythicDamage===950000,'independent damage limits save numerically');
 radar().open=false;await settle();check(getComputedStyle(radar().querySelector('.we-ago-radar-panel')).display==='none','radar collapses');
 radar().open=true;await settle();
 for(const panel of [radar().querySelector('.we-ago-radar-panel'),lootRoot().querySelector('.we-ago-loot-panel')]) {
   const box=panel.getBoundingClientRect();check(box.left>=0&&box.right<=innerWidth+1,'panels fit viewport');
 }
 const parentPanel=radar().querySelector('.we-ago-radar-panel');
 check(parentPanel.contains(lootRoot()),'filters and results share the radar scrolling panel');
 items.destroy();check(radar()&&!lootRoot(),'loot off preserves radar');check(listeners.size===1,'loot listeners cleaned independently');
 items=__weAgoLootRadar.create();await settle();check(lootRoot()?.closest('#we-ago-bounty-radar')===radar(),'loot re-enables in the same panel');
 check(document.querySelectorAll('#we-ago-bounty-radar').length===1,'no duplicate shell after re-enable');
 bounty.destroy();contract.destroy();items.destroy();
 timer.tick();check(!document.querySelector('.we-ago-loot-countdown'),'loot disable removes countdown UI');
 const radarReads=calls.filter(type=>type==='WE_AGO_RADAR_GET').length;
 items=__weAgoLootRadar.create();await settle();
 check(radar()&&lootRoot(),'loot alone creates the shared panel');
 check(radar().getBoundingClientRect().top===stored['we-ago:radar-position'].top&&radar().getBoundingClientRect().top===22,'position restores after last feature off/on');
 check(calls.filter(type=>type==='WE_AGO_RADAR_GET').length===radarReads,'loot-only shell starts no disabled radar requests');
 check(listeners.size===1,'loot-only shell starts no opportunity listener');
 bounty=__weAgoBountyRadar.create();contract=__weAgoContractRadar.create();await settle();
 check(document.querySelectorAll('#we-ago-bounty-radar').length===1,'enabling opportunities reuses loot-only shell');
 check(radar().querySelector('.we-ago-radar-panel').firstElementChild.classList.contains('we-ago-radar-opportunities'),'stable section order after toggling');
 timer.destroy();
 parent.postMessage({radarResult:'PASS unified radar/loot panel, independent lifecycle, late responses, contract remove/restore, saved loot damage form, safe links and layout; viewport '+innerWidth},'*');
}
const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#0c1421}</style><style>${styles}</style><body><script>${setup}</script><script>${modules}</script><script>(${checks.toString()})().catch(error=>parent.postMessage({radarResult:'FAIL '+error.stack},'*'));</script>`;
try {
 for(const width of [1100,390]) {
  fs.writeFileSync(fixture,`<!doctype html><style>body{margin:0;background:#0c1421}iframe{border:0;width:${width}px;height:800px}</style><iframe></iframe><pre id="result" hidden></pre><script>addEventListener('message',e=>{if(e.source===document.querySelector('iframe').contentWindow)document.getElementById('result').textContent=e.data.radarResult});document.querySelector('iframe').srcdoc=${JSON.stringify(html).replace(/</g,"\\u003c")};</script>`);
  const screenshot=process.env.RADAR_SCREENSHOT_DIR;
  const run=spawnSync(chrome,["--headless=new","--disable-gpu","--no-first-run",`--user-data-dir=${path.join(directory,"profile")}`,`--window-size=${width},850`,"--virtual-time-budget=3000","--dump-dom",...(screenshot?[`--screenshot=${path.join(screenshot,"radar-search-"+width+".png")}`]:[]),pathToFileURL(fixture).href],{encoding:"utf8",windowsHide:true,timeout:30000,maxBuffer:2e6});
  assert.equal(run.status,0,run.error?.message||run.stderr);
  const result=run.stdout.match(/<pre id="result"[^>]*>([^<]*)<\/pre>/)?.[1];
  assert.match(result||"No browser result",/^PASS /);assert(result.endsWith("viewport "+width),result);
  console.log(result);
 }
} finally {fs.unlinkSync(fixture);}


