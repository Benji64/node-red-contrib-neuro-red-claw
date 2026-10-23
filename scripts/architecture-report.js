#!/usr/bin/env node
/**
 * État de l'architecture RÉELLE, calculé depuis le dépôt — jamais écrit
 * à la main (un document décrivant le code finit par diverger du code).
 *
 * Couverture, définitions strictes :
 *   node test    : un fichier test/nodes/<nœud>.test.js existe
 *   contrat réel : un test compare le contrat YAML à la sortie réelle du
 *                  nœud (validate(...) contre un vrai msg de sortie)
 *   e2e          : le type du nœud est déployé dans un test/e2e/*.js
 *   lib testée   : test/lib/<lib>.test.js existe
 * Un nœud sans AUCUNE de ces preuves est "non vérifié" — son contrat
 * YAML est alors une affirmation, pas un fait.
 */
const fs   = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const ls = (d) => (exists(d) ? fs.readdirSync(path.join(ROOT, d)) : []);

function build() {
  const pkg   = JSON.parse(read("package.json"));
  const nodes = Object.entries(pkg["node-red"].nodes);
  const nodeTests = ls("test/nodes").filter(f => f.endsWith(".test.js"));
  const libTests  = ls("test/lib").filter(f => f.endsWith(".test.js"));
  const nodeTestSrcs = nodeTests.map(f => read("test/nodes/" + f));
  const e2eSrc    = ls("test/e2e").filter(f => f.endsWith(".js")).map(f => read("test/e2e/" + f)).join("\n");

  const rows = nodes.map(([type, file]) => {
    const src = read(file);
    const testBasenames = new Set([
      `${type}.test.js`,
      `${path.basename(file, ".js")}.test.js`,
    ]);
    const libs = [...src.matchAll(/require\("\.\.\/lib\/([\w-]+)"\)/g)].map(m => m[1]);
    const quotedType = type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const contractReal = nodeTestSrcs.some(testSrc =>
      new RegExp(`loadContract\\(["']${quotedType}["']\\)`).test(testSrc) &&
      /\bvalidate\s*\(/.test(testSrc)
    );
    return {
      type,
      contract:    exists(`contracts/${type}.yaml`),
      nodeTest:    nodeTests.some(test => testBasenames.has(test)),
      contractReal,
      e2e:         new RegExp(`type:\\s*"${type}"`).test(e2eSrc),
      libs:        [...new Set(libs)],
    };
  });

  const libs = ls("lib").filter(f => f.endsWith(".js")).map(f => f.replace(/\.js$/, ""));
  const libRows = libs.map(l => ({ lib: l, tested: libTests.includes(`${l}.test.js`) }));
  return { version: pkg.version, rows, libRows };
}

function render({ version, rows, libRows }) {
  const tick = (b) => (b ? "✅" : "—");
  const unverified = rows.filter(r => !r.nodeTest && !r.e2e);
  const L = [
    "# État de l'architecture (généré)",
    "",
    "**Généré par `node scripts/architecture-report.js` — ne pas éditer à la main.**",
    "",
    `Version : ${version} — ${rows.length} nœuds, ${libRows.length} libs.`,
    "",
    "## Nœuds",
    "",
    "| Nœud | Contrat | Test nœud | Contrat vérifié (réel) | e2e | Libs |",
    "|---|---|---|---|---|---|",
    ...rows.map(r => `| \`${r.type}\` | ${tick(r.contract)} | ${tick(r.nodeTest)} | ${tick(r.contractReal)} | ${tick(r.e2e)} | ${r.libs.join(", ") || "—"} |`),
    "",
    `**Non vérifiés (ni test nœud ni e2e) : ${unverified.length}** — ` +
      (unverified.length ? unverified.map(r => `\`${r.type}\``).join(", ") : "aucun"),
    "",
    "## Libs",
    "",
    "| Lib | Testée |",
    "|---|---|",
    ...libRows.map(r => `| \`${r.lib}\` | ${tick(r.tested)} |`),
    "",
    `**Libs sans test : ${libRows.filter(r => !r.tested).length}** — ` +
      (libRows.filter(r => !r.tested).map(r => `\`${r.lib}\``).join(", ") || "aucune"),
    "",
  ];
  return L.join("\n");
}

function generate() {
  const data = build();
  const out = path.join(ROOT, "docs", "ARCHITECTURE_STATE.md");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, render(data));
  return data;
}

if (require.main === module) {
  const d = generate();
  const unv = d.rows.filter(r => !r.nodeTest && !r.e2e).length;
  const real = d.rows.filter(r => r.contractReal).length;
  console.log(`nœuds: ${d.rows.length} | contrat vérifié contre le réel: ${real}/${d.rows.filter(r=>r.contract).length} | non vérifiés: ${unv} | libs sans test: ${d.libRows.filter(r=>!r.tested).length}/${d.libRows.length}`);
}
module.exports = { build, render, generate };
