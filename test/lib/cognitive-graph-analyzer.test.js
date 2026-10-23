/**
 * Vérifie les règles architecturales du graph analyzer, notamment les
 * frontières de contrôle, les cycles, l'ownership et les graphes profonds.
 */
const test   = require("node:test");
const assert = require("node:assert/strict");
const graphAnalyzer = require("../../lib/cognitive-graph-analyzer");
const { analyzeFlow } = graphAnalyzer;

const CONTRACTS = {
  "test-reflect": { category: "reflection" },
  "test-reasoning": { category: "reasoning" },
  "test-exec":    { category: "execution" },
  "test-decision":{ category: "decision" },
  "test-convergence": { category: "convergence" },
  "test-policy":  { category: "constraint", outputSemantics: ["allow", "review", "deny"] },
  "test-safety":  { category: "safety", outputSemantics: ["allow", "review", "deny"] },
  "test-safety-undeclared": { category: "safety" },
  "test-approval":{ category: "human_approval", outputSemantics: ["queue", "approve", "reject"] },
  "test-hub":     { category: "routing" },
  "test-analysis":{ category: "analysis" },
  "function":     { category: undefined },
  "redclaw-hub": { category: "routing" },
  "redclaw-diverge": { category: "analysis" },
  "mcp-router": { category: "execution" },
  "mcp-adapter": { category: "execution" },
  "redclaw-policy": { category: "constraint", outputSemantics: ["allow", "review", "deny"] },
  "security-gate": { category: "safety", outputSemantics: ["allow", "review", "deny"] },
  "neuro-approval": { category: "human_approval", outputSemantics: ["queue", "approve", "reject"] },
};

test("la liste des types à timeout vérifié ne permet pas de modifier les règles globales", () => {
  graphAnalyzer.CYCLE_SAFE_NODE_TYPES.add("test-hub");

  const result = analyzeFlow([
    { id: "a", type: "test-hub", wires: [["b"]] },
    { id: "b", type: "function", wires: [["a"]] },
  ], CONTRACTS);

  assert.equal(result.ruleC.length, 1);
});

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

test("Règle A : une catégorie constraint personnalisée ne masque pas execution", () => {
  const flow = [
    { id: "a", type: "test-reflect", wires: [["p"]] },
    { id: "p", type: "test-policy",  wires: [["b"]] },
    { id: "b", type: "test-exec",    wires: [[]] },
  ];
  const result = analyzeFlow(flow, CONTRACTS);
  assert.equal(result.ruleA.length, 1);
  assert.match(result.ruleA[0].message, /décideur canonique "redclaw-orchestrator"/);
});

test("Règle A : le décideur canonique délègue à la règle B les contrôles d'autorité", () => {
  const flow = [
    { id: "reflect", type: "test-reflect", wires: [["decision"]] },
    { id: "decision", type: "redclaw-orchestrator", wires: [["policy"], [], [], []] },
    { id: "policy", type: "redclaw-policy", wires: [["safety"], [], []] },
    { id: "safety", type: "security-gate", wires: [["exec"], [], []] },
    { id: "exec", type: "mcp-router", wires: [[]] },
  ];
  const result = analyzeFlow(flow);
  assert.equal(result.ruleA.length, 0);
  assert.equal(result.ruleB.length, 0, result.violations.map(v => v.message).join("\n"));
});

test("Règle A : redclaw-orchestrator sans catégorie decision ne masque pas execution", () => {
  const flow = [
    { id: "reflect", type: "test-reflect", wires: [["orchestrator"]] },
    { id: "orchestrator", type: "redclaw-orchestrator", wires: [["exec"]] },
    { id: "exec", type: "test-exec", wires: [[]] },
  ];
  const contracts = {
    ...CONTRACTS,
    "redclaw-orchestrator": { category: "routing" },
  };

  const result = analyzeFlow(flow, contracts);

  assert.equal(result.ruleA.length, 1);
});

test("Règle A : reconstruit le chemin d'une longue chaîne seulement sur violation", () => {
  const length = 4000;
  const flow = Array.from({ length }, (_, index) => ({
    id: `node-${index}`,
    type: index === 0
      ? "test-reflect"
      : index === length - 1 ? "test-exec" : "function",
    wires: index + 1 < length ? [[`node-${index + 1}`]] : [[]],
  }));

  const result = analyzeFlow(flow, CONTRACTS);

  assert.equal(result.ruleA.length, 1);
  assert.equal(result.ruleA[0].path.length, length);
  assert.equal(result.ruleA[0].path[0], "node-0");
  assert.equal(result.ruleA[0].path[length - 1], `node-${length - 1}`);
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

test("Règle C : les clés de déduplication distinguent les identifiants contenant des virgules", () => {
  const flow = [
    { id: "a,b", type: "function", wires: [["c"]] },
    { id: "c", type: "function", wires: [["a,b"]] },
    { id: "a", type: "function", wires: [["b,c"]] },
    { id: "b,c", type: "function", wires: [["a"]] },
  ];

  const result = analyzeFlow(flow, CONTRACTS);

  assert.equal(result.ruleC.length, 2);
  assert.deepEqual(
    result.ruleC.map(violation => violation.path),
    [["a,b", "c"], ["a", "b,c"]],
  );
});

test("Règle C : cycle contenant redclaw-hub (timeout vérifié) = PAS de violation", () => {
  const flow = [
    { id: "a", type: "redclaw-hub", wires: [["b"]] },
    { id: "b", type: "function", wires: [["a"]] },
  ];
  const result = analyzeFlow(flow, CONTRACTS);
  assert.equal(result.ok, true, "un cycle passant par le Hub est le pattern de délégation légitime");
});

test("Règle C : une catégorie routing personnalisée sans timeout vérifié ne protège pas un cycle", () => {
  const flow = [
    { id: "a", type: "test-hub", wires: [["b"]] },
    { id: "b", type: "function", wires: [["a"]] },
  ];

  const result = analyzeFlow(flow, CONTRACTS);

  assert.equal(result.ruleC.length, 1);
  assert.deepEqual(result.ruleC[0].path, ["a", "b"]);
});

test("Règle C : neuro-envelope ne protège pas un cycle malgré sa catégorie routing", () => {
  const flow = [
    { id: "envelope", type: "neuro-envelope", wires: [["function"], []] },
    { id: "function", type: "function", wires: [["envelope"]] },
  ];

  const result = analyzeFlow(flow);

  assert.equal(result.ruleC.length, 1);
  assert.deepEqual(result.ruleC[0].path, ["envelope", "function"]);
});

test("Règle C : un cycle sûr ne masque pas un cycle imbriqué non sûr", () => {
  const flow = [
    { id: "a", type: "function", wires: [["hub", "c"]] },
    { id: "hub", type: "redclaw-hub", wires: [["c"]] },
    { id: "c", type: "function", wires: [["a"]] },
  ];
  const result = analyzeFlow(flow, CONTRACTS);
  assert.equal(result.ruleC.length, 1);
  assert.deepEqual(result.ruleC[0].path, ["a", "c"]);
});

test("Règle C : analyse une longue chaîne cyclique sans récursion", () => {
  const length = 12000;
  const flow = Array.from({ length }, (_, index) => ({
    id: `node-${index}`,
    type: "function",
    wires: [[index + 1 < length ? `node-${index + 1}` : "node-6000"]],
  }));

  const result = analyzeFlow(flow, CONTRACTS);
  assert.equal(result.ruleC.length, 1);
  assert.equal(result.ruleC[0].path.length, length - 6000);
});

test("Règle C : mcp-router protège un cycle avec timeout vérifié", () => {
  const flow = [
    { id: "a", type: "mcp-router", wires: [["b"]] },
    { id: "b", type: "function",  wires: [["a"]] },
  ];
  const result = analyzeFlow(flow, CONTRACTS);
  assert.equal(result.ok, true, "execution a un timeout vérifié dans ce projet — cycle légitime");
});

test("Règle C : mcp-adapter protège un cycle avec timeout vérifié", () => {
  const flow = [
    { id: "adapter", type: "mcp-adapter", wires: [["function"], []] },
    { id: "function", type: "function", wires: [["adapter"]] },
  ];

  const result = analyzeFlow(flow);

  assert.equal(result.ruleC.length, 0);
});

test("Règle C : redclaw-diverge protège un cycle avec timeout vérifié", () => {
  // redclaw-diverge : broadcast N branches + attente + timeout, même
  // pattern structurel que mcp-router/mcp-adapter — timeout vérifié
  // et corrigé en v2.16, faux positif trouvé en testant ce cas précis.
  const flow = [
    { id: "a", type: "redclaw-diverge", wires: [["b"]] },
    { id: "b", type: "function",      wires: [["a"]] },
  ];
  const result = analyzeFlow(flow, CONTRACTS);
  assert.equal(result.ok, true, "analysis (diverge) a un timeout vérifié — cycle légitime");
});

test("Règle C : une catégorie execution personnalisée sans timeout vérifié ne protège pas un cycle", () => {
  const flow = [
    { id: "a", type: "test-exec", wires: [["b"]] },
    { id: "b", type: "function", wires: [["a"]] },
  ];

  const result = analyzeFlow(flow, CONTRACTS);

  assert.equal(result.ruleC.length, 1);
  assert.deepEqual(result.ruleC[0].path, ["a", "b"]);
});

test("flow conforme avec décision et barrières → ok:true, aucune violation", () => {
  const flow = [
    { id: "entry", type: "test-hub", wires: [["decision"]] },
    { id: "decision", type: "test-decision", wires: [["policy"]] },
    { id: "policy", type: "redclaw-policy", wires: [["safety"], [], []] },
    { id: "safety", type: "security-gate", wires: [["execution"], [], []] },
    { id: "execution", type: "test-exec", wires: [[]] },
  ];
  const result = analyzeFlow(flow, CONTRACTS);
  assert.equal(result.ok, true, result.violations.map(v => v.message).join("\n"));
  assert.equal(result.violations.length, 0);
});

test("Règle E : rejette un input qui n'est pas un tableau", () => {
  const result = analyzeFlow(null, CONTRACTS);
  assert.equal(result.ok, false);
  assert.equal(result.ruleE.length, 1);
});

test("Règle E : rejette les ids dupliqués au lieu d'écraser un nœud", () => {
  const flow = [
    { id: "same", type: "function", wires: [["same"]] },
    { id: "same", type: "test-exec", wires: [[]] },
  ];
  const result = analyzeFlow(flow, CONTRACTS);
  assert.equal(result.ok, false);
  assert.equal(result.ruleE.length, 1);
  assert.match(result.ruleE[0].message, /id de nœud dupliqué/);
  assert.deepEqual(result.ruleA, []);
});

test("Règle E : analyse les identifiants spéciaux sans collision d'objet", () => {
  const flow = [
    { id: "__proto__", type: "function", wires: [["constructor"]] },
    { id: "constructor", type: "function", wires: [["__proto__"]] },
  ];

  const result = analyzeFlow(flow, CONTRACTS);

  assert.equal(result.ruleE.length, 0);
  assert.equal(result.ruleC.length, 1);
  assert.deepEqual(result.ruleC[0].path, ["__proto__", "constructor"]);
});

test("Règle E : détecte les cibles de fils absentes", () => {
  const flow = [{ id: "source", type: "function", wires: [["missing"]] }];
  const result = analyzeFlow(flow, CONTRACTS);
  assert.equal(result.ok, false);
  assert.equal(result.ruleE.length, 1);
  assert.equal(result.ruleE[0].targetId, "missing");
});

test("Règle E : signale les cibles absentes même si le flow a d'autres erreurs structurelles", () => {
  const flow = [
    { id: "duplicate", type: "function", wires: [["missing"]] },
    { id: "duplicate", type: "function", wires: [[]] },
  ];

  const result = analyzeFlow(flow, CONTRACTS);

  assert.ok(result.ruleE.some(violation => violation.message.includes("id de nœud dupliqué")));
  assert.ok(result.ruleE.some(violation => violation.targetId === "missing"));
});

test("Règle E : rejette une structure wires mal formée", () => {
  const flow = [{ id: "source", type: "function", wires: [["target"], "not-an-output"] }];
  const result = analyzeFlow(flow, CONTRACTS);
  assert.equal(result.ok, false);
  assert.equal(result.ruleE.length, 2);
  assert.ok(result.ruleE.some(violation => violation.targetId === "target"));
});

test("Règle E : rejette les trous dans les tableaux wires", () => {
  const sparseOutput = [];
  sparseOutput.length = 1;
  const sparseWires = [];
  sparseWires.length = 1;
  const result = analyzeFlow([
    { id: "sparse-target", type: "function", wires: [sparseOutput] },
    { id: "sparse-output", type: "function", wires: sparseWires },
  ], CONTRACTS);

  assert.equal(result.ruleE.length, 2);
  assert.ok(result.ruleE.every(violation => violation.message.includes("wires")));
});

test("Règle E : exige que le nombre de sorties câblées corresponde au contrat", () => {
  const contracts = {
    ...CONTRACTS,
    "fixed-gate": {
      category: "safety",
      outputs: 3,
      outputSemantics: ["allow", "review", "deny"],
    },
  };
  const flow = [
    { id: "gate", type: "fixed-gate", wires: [["exec"]] },
    { id: "exec", type: "test-exec", wires: [[]] },
  ];
  const result = analyzeFlow(flow, contracts);
  assert.equal(result.ok, false);
  assert.equal(result.ruleE.length, 1);
  assert.equal(result.ruleE[0].expectedOutputs, 3);
  assert.equal(result.ruleE[0].actualOutputs, 1);
  assert.deepEqual(result.ruleB, []);
});

test("Règle B : décision → politique → sortie autorisée → exécution est valide", () => {
  const flow = [
    { id: "decision", type: "test-decision", wires: [["policy"]] },
    { id: "policy", type: "redclaw-policy", wires: [["safety"], [], []] },
    { id: "safety", type: "security-gate", wires: [["exec"], [], []] },
    { id: "exec", type: "test-exec", wires: [[]] },
  ];
  const result = analyzeFlow(flow, CONTRACTS);
  assert.equal(result.ruleB.length, 0);
});

test("Règle K : refuse une exécution atteignable depuis une entrée sans décision", () => {
  const flow = [
    { id: "entry", type: "function", wires: [["execution"]] },
    { id: "execution", type: "test-exec", wires: [[]] },
  ];

  const result = analyzeFlow(flow, CONTRACTS);

  assert.equal(result.ruleK.length, 1);
  assert.deepEqual(result.ruleK[0].path, ["entry", "execution"]);
});

test("Règle K : rapporte les bypass de plusieurs entrées distinctes", () => {
  const flow = [
    { id: "entry-one", type: "function", wires: [["execution"]] },
    { id: "entry-two", type: "function", wires: [["execution"]] },
    { id: "execution", type: "test-exec", wires: [[]] },
  ];

  const result = analyzeFlow(flow, CONTRACTS);

  assert.equal(result.ruleK.length, 2);
  assert.deepEqual(
    result.ruleK.map(violation => violation.path),
    [["entry-one", "execution"], ["entry-two", "execution"]]
  );
});

test("Règle K : analyse une longue chaîne sans copier chaque préfixe de chemin", () => {
  const length = 4000;
  const flow = Array.from({ length }, (_, index) => ({
    id: `entry-chain-${index}`,
    type: index === length - 1 ? "test-exec" : "function",
    wires: [[index + 1 < length ? `entry-chain-${index + 1}` : "missing"]],
  }));
  flow[length - 1].wires = [[]];

  const result = analyzeFlow(flow, CONTRACTS);

  assert.equal(result.ruleK.length, 1);
  assert.equal(result.ruleK[0].path.length, length);
  assert.equal(result.ruleK[0].path[0], "entry-chain-0");
  assert.equal(result.ruleK[0].path[length - 1], `entry-chain-${length - 1}`);
});

test("Règle K : autorise une entrée qui passe par décision avant exécution", () => {
  const flow = [
    { id: "entry", type: "function", wires: [["decision"]] },
    { id: "decision", type: "test-decision", wires: [["policy"]] },
    { id: "policy", type: "redclaw-policy", wires: [["safety"], [], []] },
    { id: "safety", type: "security-gate", wires: [["execution"], [], []] },
    { id: "execution", type: "test-exec", wires: [[]] },
  ];

  const result = analyzeFlow(flow, CONTRACTS);

  assert.equal(result.ruleK.length, 0);
  assert.equal(result.ruleB.length, 0);
});

test("Règle K : détecte un bypass qui rejoint une branche d'exécution autorisée", () => {
  const flow = [
    { id: "entry", type: "function", wires: [["decision", "execution"]] },
    { id: "decision", type: "test-decision", wires: [["policy"]] },
    { id: "policy", type: "redclaw-policy", wires: [["safety"], [], []] },
    { id: "safety", type: "security-gate", wires: [["execution"], [], []] },
    { id: "execution", type: "test-exec", wires: [[]] },
  ];

  const result = analyzeFlow(flow, CONTRACTS);

  assert.equal(result.ruleK.length, 1);
  assert.deepEqual(result.ruleK[0].path, ["entry", "execution"]);
});

test("Règle K : signale les exécutions liées à un composant sans entrée structurelle", () => {
  const flow = [
    { id: "entry", type: "function", wires: [["decision"]] },
    { id: "decision", type: "test-decision", wires: [["policy"]] },
    { id: "policy", type: "redclaw-policy", wires: [["safety"], [], []] },
    { id: "safety", type: "security-gate", wires: [["execution"], [], []] },
    { id: "cycle-a", type: "function", wires: [["cycle-b"]] },
    { id: "cycle-b", type: "function", wires: [["cycle-a", "execution"]] },
    { id: "execution", type: "test-exec", wires: [[]] },
  ];

  const result = analyzeFlow(flow, CONTRACTS);

  assert.equal(result.ruleK.length, 0);
  assert.deepEqual(result.ruleKSkipped, ["execution"]);
});

test("Règle K : couvre un nœud d'exécution à très forte convergence", () => {
  const fanIn = 140000;
  const branches = Array.from({ length: fanIn }, (_, index) => ({
    id: `branch-${index}`,
    type: "function",
    wires: [["execution"]],
  }));
  const flow = [
    { id: "decision", type: "test-decision", wires: [["policy"]] },
    { id: "policy", type: "redclaw-policy", wires: [["safety"], [], []] },
    { id: "safety", type: "security-gate", wires: [branches.map(branch => branch.id), [], []] },
    ...branches,
    { id: "execution", type: "test-exec", wires: [[]] },
  ];

  const result = analyzeFlow(flow, CONTRACTS);

  assert.equal(result.ruleK.length, 0);
  assert.deepEqual(result.ruleKSkipped, []);
});

test("Règle K : analyse un composant cyclique en partant de sa décision", () => {
  const flow = [
    { id: "decision", type: "test-decision", wires: [["policy"]] },
    { id: "policy", type: "redclaw-policy", wires: [["safety"], [], []] },
    { id: "safety", type: "security-gate", wires: [["router"], [], []] },
    { id: "router", type: "mcp-router", wires: [["adapter"], []] },
    { id: "adapter", type: "mcp-adapter", wires: [["router"], []] },
  ];

  const result = analyzeFlow(flow, CONTRACTS);

  assert.equal(result.ruleK.length, 0);
  assert.deepEqual(result.ruleKSkipped, []);
});

test("Règle K : utilise une décision comme départ de secours dans un composant sans entrée", () => {
  const flow = [
    { id: "decision", type: "test-decision", wires: [["policy"]] },
    { id: "policy", type: "redclaw-policy", wires: [["safety"], [], []] },
    { id: "safety", type: "security-gate", wires: [["execution"], [], []] },
    { id: "execution", type: "mcp-router", wires: [["decision"], []] },
  ];

  const result = analyzeFlow(flow, CONTRACTS);

  assert.equal(result.ruleK.length, 0);
  assert.deepEqual(result.ruleKSkipped, []);
});

test("Règle B : détecte un bypass de politique ou de sécurité", () => {
  const flow = [
    { id: "decision", type: "test-decision", wires: [["policy"], ["exec-direct"]] },
    { id: "policy", type: "redclaw-policy", wires: [["exec-after-policy"], [], []] },
    { id: "exec-direct", type: "test-exec", wires: [[]] },
    { id: "exec-after-policy", type: "test-exec", wires: [[]] },
  ];
  const result = analyzeFlow(flow, CONTRACTS);
  assert.equal(result.ruleB.length, 2);
  assert.ok(result.ruleB.some(v => v.missing.includes("redclaw-policy")));
  assert.ok(result.ruleB.some(v => v.missing.some(item => item.startsWith("security-gate"))));
});

test("Règle B : les identifiants avec séparateurs ne fusionnent pas des états d'autorisation distincts", () => {
  const flow = [
    { id: "decision", type: "test-decision", wires: [["alpha:1:1"], ["policy"]] },
    { id: "policy", type: "redclaw-policy", wires: [["security"], [], []] },
    { id: "security", type: "security-gate", wires: [["alpha"], [], []] },
    { id: "alpha", type: "function", wires: [["execution"]] },
    { id: "alpha:1:1", type: "function", wires: [["execution"]] },
    { id: "execution", type: "test-exec", wires: [[]] },
  ];

  const result = analyzeFlow(flow, CONTRACTS);

  assert.equal(result.ruleB.length, 1);
  assert.deepEqual(result.ruleB[0].path, ["decision", "alpha:1:1", "execution"]);
});

test("Règle B : reconstruit le chemin d'une longue chaîne sans copier les préfixes", () => {
  const length = 4000;
  const flow = Array.from({ length }, (_, index) => ({
    id: `node-${index}`,
    type: index === 0
      ? "test-decision"
      : index === length - 1 ? "test-exec" : "function",
    wires: index + 1 < length ? [[`node-${index + 1}`]] : [[]],
  }));

  const result = analyzeFlow(flow, CONTRACTS);

  assert.equal(result.ruleB.length, 1);
  assert.equal(result.ruleB[0].path.length, length);
  assert.equal(result.ruleB[0].path[0], "node-0");
  assert.equal(result.ruleB[0].path[length - 1], `node-${length - 1}`);
});

test("Règle B : les sorties review et deny de la politique ne comptent pas comme autorisation", () => {
  const flow = [
    { id: "decision", type: "redclaw-orchestrator", wires: [["policy"], [], [], []] },
    { id: "policy", type: "redclaw-policy", wires: [[], ["review-gate"], ["deny-gate"]] },
    { id: "review-gate", type: "security-gate", wires: [["exec-review"], [], []] },
    { id: "deny-gate", type: "security-gate", wires: [["exec-deny"], [], []] },
    { id: "exec-review", type: "mcp-router", wires: [[]] },
    { id: "exec-deny", type: "mcp-router", wires: [[]] },
  ];
  const result = analyzeFlow(flow);
  assert.equal(result.ruleB.length, 2);
  assert.ok(result.ruleB.every(v => v.missing.includes("redclaw-policy")));
});

test("Règle B : la sortie de refus du Security Gate n'autorise pas l'exécution", () => {
  const flow = [
    { id: "decision", type: "redclaw-orchestrator", wires: [["policy"], [], [], []] },
    { id: "policy", type: "redclaw-policy", wires: [["security"], [], []] },
    { id: "security", type: "security-gate", wires: [[], [], ["exec"]] },
    { id: "exec", type: "mcp-router", wires: [[]] },
  ];
  const result = analyzeFlow(flow);
  assert.equal(result.ruleB.length, 1);
  assert.ok(result.ruleB[0].missing.some(item => item.startsWith("security-gate")));
});

test("Règle B : une catégorie safety sans sémantique de sortie déclarée n'autorise pas", () => {
  const flow = [
    { id: "decision", type: "test-decision", wires: [["policy"]] },
    { id: "policy", type: "redclaw-policy", wires: [["safety"]] },
    { id: "safety", type: "test-safety-undeclared", wires: [["exec"]] },
    { id: "exec", type: "test-exec", wires: [[]] },
  ];
  const result = analyzeFlow(flow, CONTRACTS);
  assert.equal(result.ruleB.length, 1);
  assert.ok(result.ruleB[0].missing.some(item => item.startsWith("security-gate")));
});

test("Règle B : une sortie de confirmation exige la sortie d'approbation humaine", () => {
  const flow = [
    { id: "decision", type: "test-decision", wires: [["policy"]] },
    { id: "policy", type: "redclaw-policy", wires: [["safety"], [], []] },
    { id: "safety", type: "security-gate", wires: [[], ["approval"], ["exec"]] },
    { id: "approval", type: "neuro-approval", wires: [[], ["exec"], []] },
    { id: "exec", type: "test-exec", wires: [[]] },
  ];
  const result = analyzeFlow(flow, CONTRACTS);
  assert.equal(result.ruleB.length, 1, "la sortie de refus reste interdite, l'approbation est autorisée");
  assert.deepEqual(result.ruleB[0].path, ["decision", "policy", "safety", "exec"]);
});

test("Règle B : la sortie de confirmation seule n'autorise pas l'exécution", () => {
  const flow = [
    { id: "decision", type: "test-decision", wires: [["policy"]] },
    { id: "policy", type: "redclaw-policy", wires: [["safety"], [], []] },
    { id: "safety", type: "security-gate", wires: [[], ["exec"], []] },
    { id: "exec", type: "test-exec", wires: [[]] },
  ];
  const result = analyzeFlow(flow, CONTRACTS);
  assert.equal(result.ruleB.length, 1);
  assert.ok(result.ruleB[0].missing.some(item => item.startsWith("security-gate")));
});

test("Règle B : une barrière personnalisée ne remplace pas les autorités canoniques", () => {
  const contracts = {
    ...CONTRACTS,
    "custom-policy": { category: "constraint", outputSemantics: ["allow"] },
    "custom-safety": { category: "safety", outputSemantics: ["allow"] },
  };
  const flow = [
    { id: "decision", type: "test-decision", wires: [["custom-policy"]] },
    { id: "custom-policy", type: "custom-policy", wires: [["custom-safety"]] },
    { id: "custom-safety", type: "custom-safety", wires: [["exec"]] },
    { id: "exec", type: "test-exec", wires: [[]] },
  ];
  const result = analyzeFlow(flow, contracts);
  assert.equal(result.ruleB.length, 1);
  assert.ok(result.ruleB[0].missing.includes("redclaw-policy"));
  assert.ok(result.ruleB[0].missing.some(item => item.startsWith("security-gate")));
});

test("Règle B : le Security Gate ne peut pas précéder la politique", () => {
  const flow = [
    { id: "decision", type: "redclaw-orchestrator", wires: [["security"], [], [], []] },
    { id: "security", type: "security-gate", wires: [["policy"], [], []] },
    { id: "policy", type: "redclaw-policy", wires: [["exec"], [], []] },
    { id: "exec", type: "mcp-router", wires: [[]] },
  ];
  const result = analyzeFlow(flow);
  assert.equal(result.ruleB.length, 1);
  assert.ok(result.ruleB[0].missing.some(item => item.startsWith("security-gate")));
});

test("Règle B : une nouvelle décision de politique invalide une autorisation sécurité antérieure", () => {
  const flow = [
    { id: "decision", type: "redclaw-orchestrator", wires: [["policy-first"], [], [], []] },
    { id: "policy-first", type: "redclaw-policy", wires: [["security"], [], []] },
    { id: "security", type: "security-gate", wires: [["policy-second"], [], []] },
    { id: "policy-second", type: "redclaw-policy", wires: [["exec"], [], []] },
    { id: "exec", type: "mcp-router", wires: [[]] },
  ];
  const result = analyzeFlow(flow);
  assert.equal(result.ruleB.length, 1);
  assert.ok(result.ruleB[0].missing.some(item => item.startsWith("security-gate")));
});

test("Règle D : un contrat non décisionnel ne peut pas écrire redclaw.tool", () => {
  const contracts = {
    ...CONTRACTS,
    "unauthorized-writer": {
      category: "execution",
      writes: ["redclaw.tool"],
    },
  };
  const result = analyzeFlow([], contracts);
  assert.equal(result.ruleD.length, 1);
  assert.equal(result.ruleD[0].contract, "unauthorized-writer");
});

test("Règle D : un contrat personnalisé de catégorie decision ne peut pas écrire redclaw.tool", () => {
  const contracts = {
    ...CONTRACTS,
    "custom-decision": {
      category: "decision",
      writes: ["redclaw.tool"],
    },
  };
  const result = analyzeFlow([], contracts);
  assert.equal(result.ruleD.length, 1);
  assert.equal(result.ruleD[0].contract, "custom-decision");
  assert.match(result.ruleD[0].message, /autorité canonique/);
});

test("Règle D : détecte les écritures tool implicites via un chemin parent ou wildcard", () => {
  const contracts = {
    ...CONTRACTS,
    "parent-writer": { category: "analysis", writes: ["redclaw"] },
    "wildcard-writer": { category: "interface", writes: ["redclaw.*"] },
  };

  const result = analyzeFlow([], contracts);

  assert.deepEqual(
    result.ruleD.map(violation => violation.contract).sort(),
    ["parent-writer", "wildcard-writer"],
  );
});

test("Règle D : un chemin interdit garde priorité sur une écriture parent large", () => {
  const contracts = {
    ...CONTRACTS,
    "safe-parent-writer": {
      category: "interface",
      writes: ["redclaw"],
      forbidden: ["redclaw.tool"],
    },
  };

  const result = analyzeFlow([], contracts);

  assert.equal(result.ruleD.length, 0);
});

test("Règle D : le contrat canonique redclaw-orchestrator peut écrire redclaw.tool", () => {
  const result = analyzeFlow([], {
    ...CONTRACTS,
    "redclaw-orchestrator": {
      category: "decision",
      writes: ["redclaw.tool"],
    },
  });
  assert.equal(result.ruleD.length, 0);
});

test("Règle G : une écriture dans le domaine d'un autre propriétaire est refusée", () => {
  const contracts = {
    ...CONTRACTS,
    "reasoning-owner": {
      category: "reasoning",
      owns: ["reasoning.*"],
      writes: ["reasoning.*"],
    },
    "decision-writer": {
      category: "decision",
      writes: ["reasoning.proposal"],
    },
  };

  const result = analyzeFlow([], contracts);

  assert.equal(result.ruleG.length, 1);
  assert.equal(result.ruleG[0].contract, "decision-writer");
  assert.equal(result.ruleG[0].owner, "reasoning-owner");
});

test("Règle G : les écritures larges respectent une exclusion forbidden ciblée", () => {
  const contracts = {
    ...CONTRACTS,
    "tool-owner": {
      category: "decision",
      owns: ["redclaw.tool"],
      writes: ["redclaw.tool"],
    },
    "legacy-writer": {
      category: "interface",
      writes: ["redclaw"],
      forbidden: ["redclaw.tool"],
    },
  };

  const result = analyzeFlow([], contracts);

  assert.equal(result.ruleG.length, 0);
});

test("Règle G : une exclusion forbidden exacte respecte un propriétaire wildcard", () => {
  const contracts = {
    ...CONTRACTS,
    "wildcard-owner": {
      category: "decision",
      owns: ["redclaw.*"],
      writes: ["redclaw.*"],
    },
    "excluded-writer": {
      category: "interface",
      writes: ["redclaw.tool"],
      forbidden: ["redclaw.tool"],
    },
  };

  const result = analyzeFlow([], contracts);

  assert.equal(result.ruleG.length, 0);
});

test("Règle G : une exclusion forbidden partielle ne masque pas les autres écritures wildcard", () => {
  const contracts = {
    ...CONTRACTS,
    "wildcard-owner": {
      category: "decision",
      owns: ["redclaw.*"],
      writes: ["redclaw.*"],
    },
    "partially-excluded-writer": {
      category: "interface",
      writes: ["redclaw.*"],
      forbidden: ["redclaw.tool"],
    },
  };

  const result = analyzeFlow([], contracts);

  assert.equal(result.ruleG.length, 1);
  assert.equal(result.ruleG[0].owner, "wildcard-owner");
});

test("Règle G : détecte les revendications de propriété qui se chevauchent", () => {
  const contracts = {
    ...CONTRACTS,
    "parent-owner": {
      category: "reasoning",
      owns: ["reasoning"],
      writes: ["reasoning"],
    },
    "child-owner": {
      category: "analysis",
      owns: ["reasoning.hypotheses"],
      writes: ["reasoning.hypotheses"],
    },
  };

  const result = analyzeFlow([], contracts);

  assert.ok(result.ruleG.some(violation =>
    violation.contracts?.includes("parent-owner") &&
    violation.contracts.includes("child-owner")
  ));
});

test("Règle G : détecte les chevauchements d'ownership avec wildcard", () => {
  const contracts = {
    ...CONTRACTS,
    "wildcard-owner": {
      category: "reasoning",
      owns: ["context.*"],
      writes: ["context.*"],
    },
    "specific-owner": {
      category: "context",
      owns: ["context.summary"],
      writes: ["context.summary"],
    },
  };

  const result = analyzeFlow([], contracts);

  assert.ok(result.ruleG.some(violation =>
    violation.contracts?.includes("wildcard-owner") &&
    violation.contracts.includes("specific-owner")
  ));
});

test("Règle G : les ownership wildcard de domaines disjoints ne se chevauchent pas", () => {
  const contracts = {
    ...CONTRACTS,
    "context-owner": {
      category: "context",
      owns: ["context.*"],
      writes: ["context.*"],
    },
    "memory-owner": {
      category: "memory",
      owns: ["memory.*"],
      writes: ["memory.*"],
    },
  };

  const result = analyzeFlow([], contracts);

  assert.equal(result.ruleG.length, 0);
});

test("Règle G : refuse un domaine possédé absent des écritures du contrat", () => {
  const result = analyzeFlow([], {
    ...CONTRACTS,
    "phantom-owner": {
      category: "reasoning",
      owns: ["reasoning.internal"],
      writes: ["reasoning.output"],
    },
  });

  assert.ok(result.ruleG.some(violation =>
    violation.contract === "phantom-owner" &&
    violation.scope === "reasoning.internal" &&
    violation.message.includes("sans écriture correspondante")
  ));
});

test("invariant architectural : safety ne peut pas modifier le domaine reasoning", () => {
  const result = analyzeFlow([], {
    ...CONTRACTS,
    "reasoning-owner": {
      category: "reasoning",
      owns: ["reasoning.*"],
      writes: ["reasoning.*"],
    },
    "safety-writer": {
      category: "safety",
      writes: ["reasoning.status"],
    },
  });

  assert.ok(result.ruleG.some(violation =>
    violation.contract === "safety-writer" &&
    violation.owner === "reasoning-owner"
  ));
});

test("invariant architectural : execution ne peut pas modifier le domaine decision", () => {
  const result = analyzeFlow([], {
    ...CONTRACTS,
    "decision-owner": {
      category: "decision",
      owns: ["decision.*"],
      writes: ["decision.*"],
    },
    "execution-writer": {
      category: "execution",
      writes: ["decision.result"],
    },
  });

  assert.ok(result.ruleG.some(violation =>
    violation.contract === "execution-writer" &&
    violation.owner === "decision-owner"
  ));
});

test("invariant architectural : learning ne peut pas modifier silencieusement policy", () => {
  const result = analyzeFlow([], {
    ...CONTRACTS,
    "policy-owner": {
      category: "constraint",
      owns: ["policy.*"],
      writes: ["policy.*"],
    },
    "learning-writer": {
      category: "learning",
      writes: ["policy.active"],
    },
  });

  assert.ok(result.ruleG.some(violation =>
    violation.contract === "learning-writer" &&
    violation.owner === "policy-owner"
  ));
});

test("Règle H : détecte une responsabilité revendiquée par plusieurs contrats", () => {
  const result = analyzeFlow([], {
    ...CONTRACTS,
    "context-builder": {
      category: "context",
      responsibilities: ["context_assembly"],
    },
    "memory-node": {
      category: "memory",
      responsibilities: ["context_assembly"],
    },
  });

  assert.equal(result.ruleH.length, 1);
  assert.equal(result.ruleH[0].responsibility, "context_assembly");
  assert.deepEqual(result.ruleH[0].contracts, ["context-builder", "memory-node"]);
});

test("Règle H : responsabilités distinctes ne créent pas de conflit", () => {
  const result = analyzeFlow([], {
    ...CONTRACTS,
    "context-builder": {
      category: "context",
      responsibilities: ["context_assembly"],
    },
    "memory-node": {
      category: "memory",
      responsibilities: ["memory_retrieval"],
    },
  });

  assert.equal(result.ruleH.length, 0);
});

test("Règle I : safety ne peut écrire dans reasoning même sans ownership déclaré", () => {
  const result = analyzeFlow([], {
    ...CONTRACTS,
    "safety-writer": {
      category: "safety",
      writes: ["reasoning.status"],
    },
  });

  assert.equal(result.ruleI.length, 1);
  assert.equal(result.ruleI[0].contract, "safety-writer");
  assert.equal(result.ruleI[0].domain, "reasoning");
});

test("Règle I : safety ne peut pas créer ou modifier directement une action", () => {
  const result = analyzeFlow([], {
    ...CONTRACTS,
    "safety-writer": {
      category: "safety",
      writes: ["action.request"],
    },
  });

  assert.equal(result.ruleI.length, 1);
  assert.equal(result.ruleI[0].domain, "action");
});

test("Règle I : decision ne peut écrire dans safety ou action", () => {
  const result = analyzeFlow([], {
    ...CONTRACTS,
    "decision-writer": {
      category: "decision",
      writes: ["safety.verdict", "action.request"],
    },
  });

  assert.deepEqual(
    result.ruleI.map(violation => violation.domain),
    ["safety", "action"]
  );
});

test("Règle I : reasoning ne peut écrire dans decision, safety ou action", () => {
  const result = analyzeFlow([], {
    ...CONTRACTS,
    "reasoning-writer": {
      category: "reasoning",
      writes: ["decision.result", "safety.verdict", "action.request"],
    },
  });

  assert.deepEqual(
    result.ruleI.map(violation => violation.domain),
    ["decision", "safety", "action"]
  );
});

test("Règle I : les métadonnées safety sous redclaw restent permises pour decision", () => {
  const result = analyzeFlow([], {
    ...CONTRACTS,
    "decision-writer": {
      category: "decision",
      writes: ["redclaw.safetyAssessment.decision"],
    },
  });

  assert.equal(result.ruleI.length, 0);
});

test("Règle I : execution ne peut écrire dans decision même sans ownership déclaré", () => {
  const result = analyzeFlow([], {
    ...CONTRACTS,
    "execution-writer": {
      category: "execution",
      writes: ["decision.result"],
    },
  });

  assert.equal(result.ruleI.length, 1);
  assert.equal(result.ruleI[0].domain, "decision");
});

test("Règle I : forbidden neutralise l'écriture interdite de la catégorie", () => {
  const result = analyzeFlow([], {
    ...CONTRACTS,
    "restricted-execution-writer": {
      category: "execution",
      writes: ["decision.result"],
      forbidden: ["decision.result"],
    },
  });

  assert.equal(result.ruleI.length, 0);
});

test("Règle I : forbidden ciblé ne masque pas les autres écritures wildcard", () => {
  const result = analyzeFlow([], {
    ...CONTRACTS,
    "partially-restricted-execution-writer": {
      category: "execution",
      writes: ["decision.*"],
      forbidden: ["decision.result"],
    },
  });

  assert.equal(result.ruleI.length, 1);
  assert.equal(result.ruleI[0].path, "decision.*");
});

test("Règle I : learning ne peut écrire dans policy même sans ownership déclaré", () => {
  const result = analyzeFlow([], {
    ...CONTRACTS,
    "learning-writer": {
      category: "learning",
      writes: ["policy.active"],
    },
  });

  assert.equal(result.ruleI.length, 1);
  assert.equal(result.ruleI[0].domain, "policy");
});

test("Règle I : les autres domaines ne sont pas affectés", () => {
  const result = analyzeFlow([], {
    ...CONTRACTS,
    "safe-safety-writer": {
      category: "safety",
      writes: ["redclaw_safety.assessment", "redclaw_authorization"],
    },
    "safe-execution-writer": {
      category: "execution",
      writes: ["routeur.callId"],
    },
    "safe-learning-writer": {
      category: "learning",
      writes: ["learning.candidates"],
    },
  });

  assert.equal(result.ruleI.length, 0);
});

test("Règle G : owns ciblé ne restreint pas les autres écritures déclarées du même nœud", () => {
  const contracts = {
    ...CONTRACTS,
    "narrow-owner": {
      category: "reasoning",
      owns: ["reasoning.proposal"],
      writes: ["reasoning"],
    },
    "sibling-writer": {
      category: "analysis",
      writes: ["reasoning.other"],
    },
  };

  const result = analyzeFlow([], contracts);

  assert.equal(result.ruleG.length, 0);
});

test("Règle G : exige owns pour un domaine spécialisé à écrivain unique", () => {
  const result = analyzeFlow([], {
    ...CONTRACTS,
    "unique-writer": {
      category: "memory",
      writes: ["private_context.summary"],
    },
  });

  assert.equal(result.ruleG.length, 1);
  assert.equal(result.ruleG[0].contract, "unique-writer");
  assert.equal(result.ruleG[0].path, "private_context.summary");
});

test("Règle G : un écrivain forbidden n'empêche pas de détecter l'écrivain unique", () => {
  const result = analyzeFlow([], {
    ...CONTRACTS,
    "broad-excluded-writer": {
      category: "memory",
      writes: ["private_context.*"],
      forbidden: ["private_context.summary"],
    },
    "unique-summary-writer": {
      category: "memory",
      writes: ["private_context.summary"],
    },
  });

  assert.equal(result.ruleG.length, 1);
  assert.equal(result.ruleG[0].contract, "unique-summary-writer");
  assert.equal(result.ruleG[0].path, "private_context.summary");
});

test("Règle G : les racines génériques partagées restent exemptées de owns", () => {
  const result = analyzeFlow([], {
    ...CONTRACTS,
    "generic-writer": {
      category: "interface",
      writes: ["payload"],
    },
  });

  assert.equal(result.ruleG.length, 0);
});

test("Règle F : reasoning ne peut atteindre execution sans traverser decision", () => {
  const flow = [
    { id: "reasoning", type: "test-reasoning", wires: [["neutral"]] },
    { id: "neutral", type: "function", wires: [["execution"]] },
    { id: "execution", type: "test-exec", wires: [[]] },
  ];
  const result = analyzeFlow(flow, CONTRACTS);

  assert.equal(result.ruleF.length, 1);
  assert.deepEqual(result.ruleF[0].path, ["reasoning", "neutral", "execution"]);
});

test("Règle F : reasoning → decision → policy → safety → execution est valide", () => {
  const flow = [
    { id: "reasoning", type: "test-reasoning", wires: [["convergence"]] },
    { id: "convergence", type: "test-convergence", wires: [["decision"]] },
    { id: "decision", type: "redclaw-orchestrator", wires: [["policy"], [], [], []] },
    { id: "policy", type: "redclaw-policy", wires: [["safety"], [], []] },
    { id: "safety", type: "security-gate", wires: [["execution"], [], []] },
    { id: "execution", type: "mcp-router", wires: [[]] },
  ];
  const result = analyzeFlow(flow);

  assert.equal(result.ruleF.length, 0);
  assert.equal(result.ruleB.length, 0);
});

test("Règle F : reconstruit le chemin d'une longue chaîne sans copier les préfixes", () => {
  const length = 4000;
  const flow = Array.from({ length }, (_, index) => ({
    id: `node-${index}`,
    type: index === 0
      ? "test-reasoning"
      : index === length - 1 ? "test-exec" : "function",
    wires: index + 1 < length ? [[`node-${index + 1}`]] : [[]],
  }));

  const result = analyzeFlow(flow, CONTRACTS);

  assert.equal(result.ruleF.length, 1);
  assert.equal(result.ruleF[0].path.length, length);
  assert.equal(result.ruleF[0].path[0], "node-0");
  assert.equal(result.ruleF[0].path[length - 1], `node-${length - 1}`);
});

test("Règle J : refuse une décision directe depuis reasoning", () => {
  const flow = [
    { id: "reasoning", type: "test-reasoning", wires: [["decision"]] },
    { id: "decision", type: "test-decision", wires: [[]] },
  ];

  const result = analyzeFlow(flow, CONTRACTS);

  assert.equal(result.ruleJ.length, 1);
  assert.deepEqual(result.ruleJ[0].path, ["reasoning", "decision"]);
});

test("Règle J : reconstruit le chemin d'une longue chaîne sans copier les préfixes", () => {
  const length = 4000;
  const flow = Array.from({ length }, (_, index) => ({
    id: `node-${index}`,
    type: index === 0
      ? "test-reasoning"
      : index === length - 1 ? "test-decision" : "function",
    wires: index + 1 < length ? [[`node-${index + 1}`]] : [[]],
  }));

  const result = analyzeFlow(flow, CONTRACTS);

  assert.equal(result.ruleJ.length, 1);
  assert.equal(result.ruleJ[0].path.length, length);
  assert.equal(result.ruleJ[0].path[0], "node-0");
  assert.equal(result.ruleJ[0].path[length - 1], `node-${length - 1}`);
});

test("Règle J : un nœud intermédiaire non catégorisé convergence ne suffit pas", () => {
  const flow = [
    { id: "reasoning", type: "test-reasoning", wires: [["intermediate"]] },
    { id: "intermediate", type: "test-analysis", wires: [["decision"]] },
    { id: "decision", type: "test-decision", wires: [[]] },
  ];

  const result = analyzeFlow(flow, CONTRACTS);

  assert.equal(result.ruleJ.length, 1);
  assert.deepEqual(result.ruleJ[0].path, ["reasoning", "intermediate", "decision"]);
});

test("Règle J : une catégorie convergence explicite satisfait la frontière", () => {
  const flow = [
    { id: "reasoning", type: "test-reasoning", wires: [["convergence"]] },
    { id: "convergence", type: "test-convergence", wires: [["decision"]] },
    { id: "decision", type: "test-decision", wires: [[]] },
  ];

  const result = analyzeFlow(flow, CONTRACTS);

  assert.equal(result.ruleJ.length, 0);
});

test("Règle J : détecte une branche qui contourne convergence même si une autre la traverse", () => {
  const flow = [
    { id: "reasoning", type: "test-reasoning", wires: [["convergence", "decision"]] },
    { id: "convergence", type: "test-convergence", wires: [["decision"]] },
    { id: "decision", type: "test-decision", wires: [[]] },
  ];

  const result = analyzeFlow(flow, CONTRACTS);

  assert.equal(result.ruleJ.length, 1);
  assert.deepEqual(result.ruleJ[0].path, ["reasoning", "decision"]);
});

test("les contrats réels produisent un flow décisionnel protégé sans violation", () => {
  const flow = [
    { id: "skill",  type: "redclaw-skill",         wires: [["orch"]] },
    { id: "orch",   type: "redclaw-orchestrator",  wires: [["policy"], [], [], []] },
    { id: "policy", type: "redclaw-policy",        wires: [["security"], [], []] },
    { id: "security", type: "security-gate",       wires: [["router"], [], []] },
    { id: "router", type: "mcp-router",            wires: [["adapter"], ["orch"]] },
    { id: "adapter",type: "mcp-adapter",           wires: [["router"], []] },
    { id: "reflect",type: "redclaw-reflect",       wires: [[], []] },
    { id: "hub",    type: "redclaw-hub",           wires: [["skill"]] },
  ];
  const result = analyzeFlow(flow);
  assert.equal(result.ok, true, result.violations.map(v => v.message).join("\n"));
  assert.equal(result.ruleG.length, 0);
});
