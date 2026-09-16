/**
 * neuro-red-claw — Cognitive Contract Validator
 *
 * Vérifie qu'un nœud ne modifie que les champs msg déclarés dans son
 * contrat (contracts/*.yaml). Diff STRICTEMENT PAR VALEUR entre l'état
 * avant et après passage dans le nœud — jamais par référence, après
 * les bugs de mutation trouvés dans goal-store.js/longterm-memory.js/
 * skill-registry.js/neuro-message.js plus tôt dans ce projet.
 */
const fs   = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const CONTRACTS_DIR = path.join(__dirname, "..", "contracts");
const GLOBAL_IGNORED = ["_msgid"];

function loadContract(nodeType) {
  const file = path.join(CONTRACTS_DIR, `${nodeType}.yaml`);
  if (!fs.existsSync(file)) {
    throw new Error(`Aucun contrat pour "${nodeType}" — attendu: ${file}`);
  }
  const doc = yaml.load(fs.readFileSync(file, "utf8"));
  return {
    node: doc.node, category: doc.category,
    reads: doc.reads || [], writes: doc.writes || [], forbidden: doc.forbidden || [],
    outputs: doc.outputs, notes: doc.notes || "",
  };
}

function loadAllContracts() {
  if (!fs.existsSync(CONTRACTS_DIR)) return {};
  const files = fs.readdirSync(CONTRACTS_DIR).filter(f => f.endsWith(".yaml"));
  const contracts = {};
  for (const f of files) contracts[f.replace(/\.yaml$/, "")] = loadContract(f.replace(/\.yaml$/, ""));
  return contracts;
}

function snapshot(msg) {
  return JSON.parse(JSON.stringify(msg ?? {}));
}

function _deepDiff(before, after, prefix = "") {
  const paths = new Set();
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const key of keys) {
    const p = prefix ? `${prefix}.${key}` : key;
    const bVal = before?.[key];
    const aVal = after?.[key];
    const bothObjects = bVal && aVal && typeof bVal === "object" && typeof aVal === "object" &&
      !Array.isArray(bVal) && !Array.isArray(aVal);
    if (bothObjects) {
      for (const sub of _deepDiff(bVal, aVal, p)) paths.add(sub);
      continue;
    }
    if (JSON.stringify(bVal) !== JSON.stringify(aVal)) paths.add(p);
  }
  return [...paths];
}

function _isCovered(changedPath, declaredPaths) {
  return declaredPaths.some(d => changedPath === d || changedPath.startsWith(d + "."));
}

function validate(contract, before, after) {
  const afterSnap = snapshot(after);
  const changed = _deepDiff(before, afterSnap).filter(p => !GLOBAL_IGNORED.includes(p));
  const violations = [];
  for (const p of changed) {
    if (_isCovered(p, contract.writes)) continue;
    const isForbidden = _isCovered(p, contract.forbidden);
    violations.push(
      isForbidden
        ? `[${contract.node}] VIOLATION CRITIQUE — champ interdit "${p}" modifié (documenté comme piège connu)`
        : `[${contract.node}] champ "${p}" modifié mais absent de writes: [${contract.writes.join(", ")}]`
    );
  }
  return { ok: violations.length === 0, violations, changed };
}

module.exports = { loadContract, loadAllContracts, snapshot, validate, GLOBAL_IGNORED };
