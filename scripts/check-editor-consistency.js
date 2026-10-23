#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const pkg = require("../package.json");
const { checkNode } = require("../lib/editor-consistency");
const ROOT = path.join(__dirname, "..");
const allowFile = path.join(ROOT, "contracts", "editor-allowlist.json");
const ALLOW = fs.existsSync(allowFile) ? JSON.parse(fs.readFileSync(allowFile, "utf8")) : {};
const entries = Object.entries(pkg["node-red"].nodes);
const allJs = entries.map(([, f]) => fs.readFileSync(path.join(ROOT, f), "utf8"));
let errs = 0, warns = 0;
for (const [type, f] of entries) {
  const r = checkNode(type, path.join(ROOT, f), allJs, ALLOW);
  r.errors.forEach(e => { console.error(`ERREUR  ${type} — ${e}`); errs++; });
  r.warnings.forEach(w => { console.log(`avert.  ${type} — ${w}`); warns++; });
}
console.log(`\n${errs} erreur(s), ${warns} avertissement(s) sur ${entries.length} nœuds`);
process.exit(errs ? 1 : 0);
