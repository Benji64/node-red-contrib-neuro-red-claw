/**
 * neuro-red-claw — Cognitive Graph Analyzer
 *
 * Analyse STATIQUE d'un flows.json — propriétés structurelles du
 * câblage, jamais l'ordre temporel réel d'exécution (ça, c'est le rôle
 * du système de trace runtime déjà existant : neuro-envelope +
 * NeuroMessage.trace()).
 *
 *   RÈGLE A — Un nœud "reflection" ne doit jamais avoir un chemin
 *   câblé DIRECT vers un nœud "execution" sans traverser un point de
 *   contrôle légitime (decision, constraint, routing, interface).
 *   Traverse les nœuds de catégorie inconnue (function, change) sans
 *   s'y arrêter — sinon il suffirait d'insérer un nœud intermédiaire
 *   pour contourner la règle.
 *
 *   RÈGLE C — Tout cycle doit contenir au moins un nœud "routing"
 *   (Hub) OU "execution" (mcp-router/mcp-adapter) — les deux
 *   catégories qui implémentent un timeout vérifié sur callId dans ce
 *   projet. Les cycles router↔adapter et orchestrateur→policy→
 *   router→orchestrateur sont donc légitimes par design, pas des
 *   violations — trouvé en testant contre l'architecture réelle.
 */
const { loadAllContracts } = require("./cognitive-contract");

const CONTROL_POINT_CATEGORIES = new Set(["decision", "constraint", "routing", "interface"]);
const CYCLE_SAFE_CATEGORIES    = new Set(["routing", "execution"]);

function _categoryIndex(contracts) {
  const idx = {};
  for (const [nodeType, c] of Object.entries(contracts)) idx[nodeType] = c.category;
  return idx;
}

function _buildGraph(flowNodes) {
  const byId = {}; const adj = {};
  for (const n of flowNodes) {
    if (!n.id) continue;
    byId[n.id] = n;
    const targets = [];
    for (const output of (n.wires || [])) for (const t of (output || [])) targets.push(t);
    adj[n.id] = targets;
  }
  return { byId, adj };
}

function _checkReflectionBeforeExecution(flowNodes, categoryIndex) {
  const { byId, adj } = _buildGraph(flowNodes);
  const violations = [];
  const reflectionNodes = flowNodes.filter(n => categoryIndex[n.type] === "reflection");

  for (const start of reflectionNodes) {
    const visited = new Set();
    const stack = [{ id: start.id, path: [start.id] }];
    while (stack.length) {
      const { id, path } = stack.pop();
      for (const nextId of (adj[id] || [])) {
        if (visited.has(nextId)) continue;
        const nextNode = byId[nextId];
        if (!nextNode) continue;
        const cat = categoryIndex[nextNode.type];
        if (cat === "execution") {
          violations.push({
            rule: "A",
            message: `[Règle A] "${start.name || start.type}" (reflection) atteint ` +
                      `"${nextNode.name || nextNode.type}" (execution) sans point de ` +
                      `contrôle en chemin : ${[...path, nextId].join(" → ")}`,
            path: [...path, nextId],
          });
          continue;
        }
        visited.add(nextId);
        if (CONTROL_POINT_CATEGORIES.has(cat)) continue;
        stack.push({ id: nextId, path: [...path, nextId] });
      }
    }
  }
  return violations;
}

function _checkCyclesWithoutRouting(flowNodes, categoryIndex) {
  const { byId, adj } = _buildGraph(flowNodes);
  const color = {};
  const stackPath = [];
  const violations = [];
  const reportedCycles = new Set();

  function dfs(id) {
    color[id] = 1;
    stackPath.push(id);
    for (const nextId of (adj[id] || [])) {
      if (!byId[nextId]) continue;
      if (color[nextId] === 1) {
        const cycleStart = stackPath.indexOf(nextId);
        const cycle = stackPath.slice(cycleStart);
        const key = [...cycle].sort().join(",");
        if (!reportedCycles.has(key)) {
          reportedCycles.add(key);
          const hasSafePoint = cycle.some(cid => CYCLE_SAFE_CATEGORIES.has(categoryIndex[byId[cid]?.type]));
          if (!hasSafePoint) {
            violations.push({
              rule: "C",
              message: `[Règle C] Cycle sans nœud routing/execution (donc sans timeout connu) : ${cycle.map(cid => byId[cid]?.name || byId[cid]?.type).join(" → ")} → …`,
              path: cycle,
            });
          }
        }
      } else if (color[nextId] === undefined) {
        dfs(nextId);
      }
    }
    stackPath.pop();
    color[id] = 2;
  }

  for (const n of flowNodes) if (n.id && color[n.id] === undefined) dfs(n.id);
  return violations;
}

function analyzeFlow(flowNodes, contracts = null) {
  const c = contracts || loadAllContracts();
  const categoryIndex = _categoryIndex(c);
  const ruleA = _checkReflectionBeforeExecution(flowNodes, categoryIndex);
  const ruleC = _checkCyclesWithoutRouting(flowNodes, categoryIndex);
  const violations = [...ruleA, ...ruleC];
  return { ok: violations.length === 0, violations, ruleA, ruleC };
}

module.exports = { analyzeFlow, CONTROL_POINT_CATEGORIES, CYCLE_SAFE_CATEGORIES };
