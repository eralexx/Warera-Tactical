"use strict";
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),cp=require("node:child_process");
function playwright() {
  for(const candidate of [process.env.PLAYWRIGHT_MODULE_PATH,"playwright",path.join(os.homedir(),".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")].filter(Boolean)) {
    try { return require(candidate); } catch(error) { if(error.code!=="MODULE_NOT_FOUND")throw error; }
  }
  throw Error("Browser infrastructure: install the pinned Playwright dev dependency or set PLAYWRIGHT_MODULE_PATH.");
}
function chrome() {
  const file=[process.env.CHROME_PATH,"C:/Program Files/Google/Chrome/Application/chrome.exe","C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find(file=>file&&fs.existsSync(file));
  if(!file)throw Error("Browser infrastructure: set CHROME_PATH to a local Chrome executable.");
  return file;
}
function spawnSync(command,args,options) {
  const result=cp.spawnSync(command,args,{windowsHide:true,timeout:30000,...options});
  if(result.error || result.status!==0)throw Error("Browser infrastructure: Chrome failed before fixture verification (exit "+result.status+"). "+(result.error?.message||result.stderr||"Check sandbox process access."));
  return result;
}
module.exports={playwright,chrome,spawnSync};
