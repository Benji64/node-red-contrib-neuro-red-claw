#!/usr/bin/env node
const fs   = require("fs");
const path = require("path");
const { loadAllContracts } = require("../lib/cognitive-contract");

const OUT_FILE = path.join(__dirname, "..", "contracts", "CONTRACTS.md");
const CATEGORY_ORDER = ["interface","perception","context","memory","motivation","constraint","analysis","decision","execution","reflection","routing"];
const CATEGORY_LABELS = {
  interface: "Interface (entrée/sortie humaine)", perception: "Perception", context: "Context Builder",
  memory: "Mémoire", motivation: "Objectifs (Goals)", constraint: "Contraintes (Policies)",
  analysis: "Analyse / Hypothèses", decision: "Décision", execution: "Exécution",
  reflection: "Réflexion", routing: "Routage (Hub)",
};

function generate() {
  const contracts = loadAllContracts();
  const byCategory = {};
  for (const c of Object.values(contracts)) (byCategory[c.category] = byCategory[c.category] || []).push(c);

  const lines = [
    "# Contrats cognitifs — neuro-red-claw", "",
    "**Généré automatiquement depuis `contracts/*.yaml` — ne pas éditer à la main.**",
    "Régénérer : `node scripts/generate-contract-docs.js` après toute modification d'un .yaml.", "",
    `${Object.keys(contracts).length} nœuds contractés. Nœuds de configuration ` +
    "(`llm-config`, `embed-config`, `redclaw-policy-config`) explicitement exclus — voir `contracts/README.md`.", "",
  ];

  for (const cat of CATEGORY_ORDER) {
    const nodes = byCategory[cat];
    if (!nodes?.length) continue;
    lines.push(`## ${CATEGORY_LABELS[cat] || cat}`, "");
    for (const c of nodes.sort((a, b) => a.node.localeCompare(b.node))) {
      lines.push(`### \`${c.node}\``, "");
      if (c.description) lines.push(c.description.trim(), "");
      lines.push(`**Sorties :** ${c.outputs}`, "");
      lines.push(`**Lit :** ${c.reads.length ? c.reads.map(r => `\`${r}\``).join(", ") : "_rien_"}`);
      lines.push(`**Écrit :** ${c.writes.length ? c.writes.map(w => `\`${w}\``).join(", ") : "_rien_"}`);
      if (c.forbidden.length) lines.push(`**Interdit (piège documenté) :** ${c.forbidden.map(f => `\`${f}\``).join(", ")}`);
      if (c.notes) lines.push("", `> ${c.notes.trim().replace(/\n/g, "\n> ")}`);
      lines.push("", "---", "");
    }
  }
  fs.writeFileSync(OUT_FILE, lines.join("\n"));
  console.log(`✅ ${OUT_FILE} généré — ${Object.keys(contracts).length} nœuds`);
}

if (require.main === module) generate();
module.exports = { generate };
