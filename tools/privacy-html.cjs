"use strict";
const fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname,"..");
const source = fs.readFileSync(path.join(root,"store/PRIVACY.md"),"utf8");
const inline = value => value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
  .replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>").replace(/`([^`]+)`/g,"<code>$1</code>")
  .replace(/\[([^\]]+)\]\((https:\/\/[^)]+)\)/g,'<a href="$2">$1</a>');
const html = source.trim().split(/\r?\n\r?\n/).map(block => {
  if (block.startsWith("# ")) return `<h1>${inline(block.slice(2))}</h1>`;
  if (block.startsWith("## ")) return `<h2>${inline(block.slice(3))}</h2>`;
  if (block.startsWith("- ")) return `<ul>${block.split(/\r?\n/).map(line=>`<li>${inline(line.slice(2))}</li>`).join("")}</ul>`;
  return `<p>${inline(block)}</p>`;
}).join("\n");
fs.writeFileSync(path.join(root,"store/privacy.html"),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Warera Tactical privacy policy</title><style>body{max-width:760px;margin:48px auto;padding:0 24px;font:17px/1.65 system-ui;color:#1c2939}h1,h2{line-height:1.25}h2{margin-top:36px}a{color:#17597c}li{margin-bottom:12px}code{overflow-wrap:anywhere}</style><main>${html}</main></html>\n`);
console.log("Updated store/privacy.html from store/PRIVACY.md");
