#!/usr/bin/env node
const fs   = require("fs");
const path = require("path");
const OUT_FILE = path.join(__dirname, "..", "contracts", "CONTRACTS.md");
const before = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, "utf8") : null;
const { generate } = require("./generate-contract-docs");
generate();
const after = fs.readFileSync(OUT_FILE, "utf8");
if (before !== after) {
  console.error("❌ contracts/CONTRACTS.md était désynchronisé des .yaml — régénéré.");
  process.exit(1);
}
console.log("✅ contracts/CONTRACTS.md déjà à jour.");
