"use strict";
const fs=require("node:fs"),path=require("node:path"),cp=require("node:child_process");
process.chdir(path.join(__dirname,".."));
const group=process.argv[2]||"all";
const files=fs.readdirSync(__dirname).filter(file=>file.endsWith(".test.cjs"));
let failed=0;
const scripts=["background.js","popup.js","i18n.js",...fs.readdirSync("shared").filter(file=>file.endsWith(".js")).map(file=>"shared/"+file),...fs.readdirSync("content").filter(file=>file.endsWith(".js")).map(file=>"content/"+file),...fs.readdirSync("content/modules").map(file=>"content/modules/"+file),"locales/es.js",...fs.readdirSync("worker").map(file=>"worker/"+file)];
for(const script of scripts){const result=cp.spawnSync(process.execPath,["--check",script],{encoding:"utf8",windowsHide:true});if(result.status){failed++;console.error(result.stderr);}}
const manifest=JSON.parse(fs.readFileSync("manifest.json","utf8"));
for(const file of [manifest.background.service_worker,...manifest.content_scripts.flatMap(entry=>[...(entry.js||[]),...(entry.css||[])])])if(!fs.existsSync(file))throw Error("Missing manifest resource: "+file);
for(const file of files) {
  const integration=file.endsWith(".integration.test.cjs"),browser=!integration&&fs.readFileSync(path.join(__dirname,file),"utf8").includes("spawnSync");
  if(group!=="all" && (group==="integration"?!integration:group==="browser"?!browser:group==="fast"?integration||browser:true))continue;
  const result=cp.spawnSync(process.execPath,[path.join(__dirname,file)],{encoding:"utf8",windowsHide:true,timeout:120000});
  console.log("["+(result.status===0?"PASS":"FAIL")+"] "+file);if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);
  if(result.status!==0)failed++;
}
console.log("Syntax/manifest checks complete; failures: "+failed);process.exitCode=failed?1:0;
