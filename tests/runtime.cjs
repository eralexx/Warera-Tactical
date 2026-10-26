"use strict";
const fs = require("node:fs"), path = require("node:path");
// Fixtures execute runtime scripts outside the manifest. Mirror shared preloads.
module.exports = { ...fs, readFileSync(file, ...options) {
  const source = fs.readFileSync(file, ...options);
  const normalized = String(file).replaceAll("\\", "/");
  if (typeof source !== "string" || !/(?:^|\/)(?:background\.js|popup\.js|content\/main\.js|content\/modules\/(?:spy_xray|combat_math)\.js)$/.test(normalized)) return source;
  return ["features", "domain", "cache", "scans", "passive_cache"].map(name => fs.readFileSync(path.join(__dirname, "../shared/" + name + ".js"), "utf8")).join("\n") + "\n" + source + (/(?:^|\/)background\.js$/.test(normalized) ? ["radar", "census"].map(name => fs.readFileSync(path.join(__dirname,"../worker/" + name + ".js"),"utf8")).join("\n") : "");
} };

