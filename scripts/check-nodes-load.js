#!/usr/bin/env node
/**
 * Charge CHAQUE nœud avec un RED simulé et vérifie qu'il s'enregistre sous
 * le nom déclaré dans package.json. L'ancien contrôle de la CI ne faisait
 * que require() : il prouve que le fichier se parse, pas que le nœud
 * s'enregistre, ni sous quel nom.
 */
const path = require("path"), os = require("os");
const pkg  = require("../package.json");
const ROOT = path.join(__dirname, "..");
let failures = 0;
for (const [declared, file] of Object.entries(pkg["node-red"].nodes)) {
  const registered = [];
  const RED = {
    nodes: { createNode(n) { for (const f of ["on","status","warn","error","log","send","debug","trace"]) n[f] = () => {}; },
             registerType(name) { registered.push(name); }, getNode: () => null, eachNode: () => {} },
    auth: { needsPermission: () => (req, res, next) => next && next() },
    httpAdmin: { get() {}, post() {}, put() {}, delete() {} },
    settings: { userDir: os.tmpdir() }, util: { cloneMessage: (m) => m },
    log: { info() {}, warn() {}, error() {}, debug() {}, trace() {} },
  };
  try {
    require(path.join(ROOT, file))(RED);
    if (registered.length !== 1 || registered[0] !== declared) {
      console.error(`FAIL ${declared} : enregistre [${registered.join(", ")}] au lieu de "${declared}"`); failures++;
    } else console.log(`OK   ${declared}`);
  } catch (e) { console.error(`FAIL ${declared} : ${e.message}`); failures++; }
}
const total = Object.keys(pkg["node-red"].nodes).length;
if (failures) { console.error(`\n${failures}/${total} nœud(s) en échec`); process.exit(1); }
console.log(`\nTous les ${total} nœuds se chargent et s'enregistrent sous leur nom déclaré.`);
