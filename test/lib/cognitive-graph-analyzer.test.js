/**
 * Vérifie les deux règles structurelles du graph analyzer, avec un
 * point d'attention : la Règle A doit traverser les nœuds "neutres"
 * (function, change) sans s'y arrêter, et la Règle C ne doit pas
 * générer de faux positif sur les cycles légitimes de l'architecture
 * réelle (router↔adapter, orchestrateur→policy→router→orchestrateur).
 */
const test   = require("node:test");
const assert = require("node:assert/strict");
const { analyzeFlow } = require("../../lib/cognitive-graph-analyzer");

const CONTRACTS = {
  "test-reflect": { category: "reflection" },
  "test-exec":    { category: "execution" },
  "test-policy":  { category: "constraint" },
  "test-hub":     { category: "routing" },
  "function":     { category: undefined },
};

test("Règle A : reflection → execution direct = violation", () => {
  const flow = [
    { id: "a", type: "test-reflect", wires: [["b"]] },
    { id: "b", type: "test-exec",    wires: [[]] },
  ];
  const result = analyzeFlow(flow, CONTRACTS);
  assert.equal(result.ok, false);
  assert.equal(result.ruleA.length, 1);
});

test("Règle A : reflection → function (neutre) → execution = violation aussi (traverse le neutre)", () => {
  const flow = [
    { id: "a", type: "test-reflect", wires: [["mid"]] },
    { id: "mid", type: "function",   wires: [["b"]] },
    { id: "b", type: "test-exec",    wires: [[]] },
  ];
  const result = analyzeFlow(flow, CONTRACTS);
  assert.equal(result.ok, false, "un nœud neutre intermédiaire ne doit jamais permettre de contourner la règle");
  assert.equal(result.ruleA.length, 1);
});

test("Règle A : reflection → policy (point de contrôle) → execution = PAS de violation", () => {
  const flow = [
    { id: "a", type: "test-reflect", wires: [["p"]] },
    { id: "p", type: "test-policy",  wires: [["b"]] },
    { id: "b", type: "test-exec",    wires: [[]] },
  ];
  const result = analyzeFlow(flow, CONTRACTS);
  assert.equal(result.ok, true, "un point de contrôle légitime doit arrêter la propagation de la règle");
});

test("Règle C : cycle sans routing NI execution = violation", () => {
  const flow = [
    { id: "a", type: "function", wires: [["b"]] },
    { id: "b", type: "function", wires: [["a"]] },
  ];
  const result = analyzeFlow(flow, CONTRACTS);
  assert.equal(result.ok, false);
  assert.equal(result.ruleC.length, 1);
});

test("Règle C : cycle contenant un nœud routing = PAS de violation (délégation légitime)", () => {
  const flow = [
    { id: "a", type: "test-hub", wires: [["b"]] },
    { id: "b", type: "function", wires: [["a"]] },
  ];
  const result = analyzeFlow(flow, CONTRACTS);
  assert.equal(result.ok, true, "un cycle passant par le Hub est le pattern de délégation légitime");
});

test("Règle C : cycle contenant SEULEMENT execution (pas de routing) = PAS de violation non plus", () => {
  const flow = [
    { id: "a", type: "test-exec", wires: [["b"]] },
    { id: "b", type: "function",  wires: [["a"]] },
  ];
  const result = analyzeFlow(flow, CONTRACTS);
  assert.equal(result.ok, true, "execution a un timeout vérifié dans ce projet — cycle légitime");
});

test("flow sans aucun problème → ok:true, aucune violation", () => {
  const flow = [
    { id: "a", type: "test-hub",  wires: [["b"]] },
    { id: "b", type: "test-exec", wires: [[]] },
  ];
  const result = analyzeFlow(flow, CONTRACTS);
  assert.equal(result.ok, true);
  assert.equal(result.violations.length, 0);
});

test("les 18 vrais contrats produisent un flow de référence sans violation", () => {
  const flow = [
    { id: "skill",  type: "redclaw-skill",         wires: [["orch"]] },
    { id: "orch",   type: "redclaw-orchestrator",  wires: [["policy"], [], []] },
    { id: "policy", type: "redclaw-policy",        wires: [["router"], [], []] },
    { id: "router", type: "mcp-router",            wires: [["adapter"], ["orch"]] },
    { id: "adapter",type: "mcp-adapter",           wires: [["router"]] },
    { id: "reflect",type: "redclaw-reflect",       wires: [[], []] },
    { id: "hub",    type: "redclaw-hub",           wires: [["skill"]] },
  ];
  const result = analyzeFlow(flow);
  assert.equal(result.ok, true, result.violations.map(v => v.message).join("\n"));
});
