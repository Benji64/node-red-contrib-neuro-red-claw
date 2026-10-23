"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runTreeReasoning } = require("../../lib/tree-reasoner");
const { validateDocument } = require("../../lib/cognitive-model");

const provenance = { source: "tree-reasoner-test", recordedAt: "2026-10-10T12:00:00.000Z" };
const criteria = [{ id: "sound", weight: 1, required: true }, { id: "useful", weight: 1 }];
const root = { id: "root", branchId: "root-branch", parentId: null, childIds: [], provenance };
const budgets = {
  maxDepth: 2,
  maxBranches: 2,
  maxNodes: 12,
  maxCalls: 30,
  maxTokens: 100,
  maxCost: 1,
  timeoutMs: 1000,
  callTimeoutMs: 500,
};

function evaluator({ criteria: requested }) {
  return {
    evaluatorVersion: "fixture-v1",
    justification: "Fixture evaluation",
    results: requested.map(criterion => ({
      criterion: criterion.id,
      outcome: "pass",
      detail: "fixture",
    })),
  };
}

test("développe récursivement plusieurs niveaux et converge de façon reproductible", async () => {
  const generatedAtDepth = [];
  const generate = async ({ depth }) => {
    generatedAtDepth.push(depth);
    return depth === 0 ? ["alpha", "beta"] : ["leaf-a", "leaf-b"];
  };
  const run = () => runTreeReasoning({
    root, criteria, budgets, generate, evaluate: evaluator,
    idFactory: (() => { let n = 0; return () => `id-${++n}`; })(),
    now: () => 1000,
  });

  const first = await run();
  const second = await run();
  assert.deepEqual(generatedAtDepth, [0, 1, 1, 0, 1, 1]);
  assert.deepEqual(first, second);
  assert.equal(first.status, "completed");
  assert.equal(first.options.length, 4);
  assert.equal(validateDocument(first.document).ok, true);
  const nodes = first.document.objects.filter(record => record.type === "ThoughtNode");
  assert.ok(nodes.some(node => node.parentId !== null));
  for (const node of nodes.filter(node => node.parentId)) {
    const parent = nodes.find(candidate => candidate.id === node.parentId);
    assert.ok(parent.childIds.includes(node.id));
    const hypothesis = first.document.objects.find(record =>
      record.type === "Hypothesis" && record.id === node.branchId);
    assert.ok(hypothesis, "branchId identifies its generated hypothesis");
    assert.ok(hypothesis.dependsOn.length <= 1);
  }
});

test("respecte les plafonds de profondeur, largeur, appels, noeuds, tokens et coût", async () => {
  const result = await runTreeReasoning({
    root,
    criteria,
    budgets: { ...budgets, maxDepth: 1, maxBranches: 2, maxNodes: 2, maxCalls: 3, maxTokens: 3, maxCost: 0.03 },
    generate: async () => ({ candidates: ["first", "second", "third"], usage: { tokens: 1, cost: 0.01 } }),
    evaluate: async ({ criteria: requested }) => ({
      ...evaluator({ criteria: requested }),
      usage: { tokens: 1, cost: 0.01 },
    }),
    idFactory: (() => { let n = 0; return () => `cap-${++n}`; })(),
  });

  assert.equal(result.options.length, 1);
  assert.ok(result.metrics.nodes <= 2);
  assert.ok(result.metrics.calls <= 3);
  assert.ok(result.metrics.tokens <= 3);
  assert.ok(result.metrics.cost <= 0.03);
  assert.ok(result.budgetStops.some(stop => stop.budget === "maxBranches"));
  assert.ok(result.budgetStops.some(stop => stop.budget === "maxNodes"));
});

test("enregistre et signale un dépassement mesuré de tokens ou coût", async () => {
  const result = await runTreeReasoning({
    root, criteria, budgets: { ...budgets, maxTokens: 1 },
    generate: async () => ({ candidates: ["candidate"], usage: { tokens: 2, cost: 0 } }),
    evaluate: evaluator,
    idFactory: () => "over-budget",
  });

  assert.equal(result.status, "budget_exceeded");
  assert.equal(result.metrics.tokens, 2);
  assert.equal(result.options.length, 0);
  assert.ok(result.budgetStops.some(stop => stop.budget === "maxTokens"));
});

test("un dépassement de coût déclaré est visible et sa branche n'est pas convergée", async () => {
  const result = await runTreeReasoning({
    root,
    criteria,
    budgets: { ...budgets, maxCost: 0.02 },
    generate: async () => ({ candidates: ["candidate"], usage: { tokens: 0, cost: 0.03 } }),
    evaluate: evaluator,
    idFactory: (() => { let n = 0; return () => `cost-${++n}`; })(),
  });

  assert.equal(result.status, "budget_exceeded");
  assert.equal(result.metrics.cost, 0.03);
  assert.equal(result.options.length, 0);
  assert.ok(result.budgetStops.some(stop => stop.budget === "maxCost"));
});

test("borne le nombre de contradictions enregistrées et garde la troncature observable", async () => {
  const result = await runTreeReasoning({
    root,
    criteria,
    budgets: { ...budgets, maxDepth: 1, maxBranches: 3, maxContradictions: 1 },
    generate: async () => ["one", "two", "three"],
    evaluate: evaluator,
    confront: async ({ hypotheses }) => [
      { leftId: hypotheses[0].id, rightId: hypotheses[1].id },
      { leftId: hypotheses[0].id, rightId: hypotheses[2].id },
    ],
    idFactory: (() => { let n = 0; return () => `bounded-${++n}`; })(),
  });

  assert.equal(result.disagreements.length, 1);
  assert.ok(result.budgetStops.some(stop => stop.budget === "maxContradictions"));
  assert.ok(result.uncertainties.some(item => item.type === "confrontation_truncated"));
});

test("les callbacks ne peuvent pas modifier les critères ou les records internes par référence", async () => {
  const result = await runTreeReasoning({
    root,
    criteria,
    budgets: { ...budgets, maxDepth: 1 },
    generate: async ({ node, criteria: receivedCriteria }) => {
      node.childIds.push("forged-child");
      receivedCriteria[0].weight = 0;
      return ["safe"];
    },
    evaluate: async ({ criteria: receivedCriteria }) => ({
      evaluatorVersion: "fixture-v1",
      justification: "isolated input",
      results: receivedCriteria.map(criterion => ({ criterion: criterion.id, outcome: "pass" })),
    }),
    idFactory: (() => { let n = 0; return () => `isolation-${++n}`; })(),
  });

  const resultRoot = result.document.objects[0];
  assert.equal(resultRoot.childIds.length, 1);
  assert.equal(result.options[0].score, 1);
});

test("converge sur un candidat viable qui n'a plus d'enfant à développer", async () => {
  const result = await runTreeReasoning({
    root,
    criteria,
    budgets: { ...budgets, maxDepth: 3 },
    generate: async ({ depth }) => depth === 0 ? ["terminal"] : [],
    evaluate: evaluator,
    idFactory: (() => { let n = 0; return () => `terminal-${++n}`; })(),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.options.length, 1);
  assert.equal(result.options[0].score, 1);
});

test("converge en mode partiel sur la frontière lorsque le budget d'appels est atteint", async () => {
  const result = await runTreeReasoning({
    root,
    criteria,
    budgets: { ...budgets, maxDepth: 3, maxCalls: 2 },
    generate: async ({ depth }) => depth === 0 ? ["frontier"] : ["unreachable"],
    evaluate: evaluator,
    idFactory: (() => { let n = 0; return () => `frontier-${++n}`; })(),
  });

  assert.equal(result.status, "budget_exceeded");
  assert.equal(result.options.length, 1);
  assert.ok(result.uncertainties.some(item => item.type === "frontier_incomplete"));
});

test("élague une branche non viable tout en conservant ses records et provenance", async () => {
  const result = await runTreeReasoning({
    root, criteria, budgets: { ...budgets, maxDepth: 1 },
    generate: async () => ["keep", "prune"],
    evaluate: async ({ hypothesis, criteria: requested }) => ({
      evaluatorVersion: "fixture-v1",
      justification: `Evaluated ${hypothesis.statement}`,
      results: requested.map(criterion => ({
        criterion: criterion.id,
        outcome: hypothesis.statement === "prune" && criterion.id === "sound" ? "fail" : "pass",
      })),
    }),
    idFactory: (() => { let n = 0; return () => `prune-${++n}`; })(),
  });

  const prunedNode = result.document.objects.find(record =>
    record.type === "ThoughtNode" && record.status === "pruned");
  const prunedHypothesis = result.document.objects.find(record =>
    record.type === "Hypothesis" && record.statement === "prune");
  assert.ok(prunedNode);
  assert.ok(prunedHypothesis);
  assert.equal(prunedNode.provenance.source, "tree-reasoner:generation");
  assert.equal(prunedHypothesis.provenance.source, "tree-reasoner:generation");
  assert.ok(Date.parse(prunedNode.provenance.recordedAt));
  assert.equal(result.options.length, 1);
});

test("conserve la confiance générée séparément du score d'évaluation", async () => {
  const result = await runTreeReasoning({
    root,
    criteria: [criteria[0]],
    budgets: { ...budgets, maxDepth: 1 },
    generate: async () => [
      { statement: "high score, low confidence", confidence: 0.35 },
      { statement: "no confidence supplied" },
    ],
    evaluate: async ({ hypothesis, criteria: requested }) => ({
      evaluatorVersion: "fixture-v1",
      justification: "Independent confidence and criterion score",
      results: requested.map(criterion => ({
        criterion: criterion.id,
        outcome: hypothesis.statement === "high score, low confidence" ? "pass" : "fail",
      })),
    }),
    idFactory: (() => { let n = 0; return () => `confidence-${++n}`; })(),
  });

  const hypotheses = result.document.objects.filter(record => record.type === "Hypothesis");
  assert.equal(hypotheses[0].confidence, 0.35);
  assert.equal(Object.hasOwn(hypotheses[1], "confidence"), false);
  assert.equal(result.options[0].score, 1);
  assert.equal(result.options[0].confidence, 0.35);

  const evaluatedEvents = result.trace.filter(event =>
    ["branch_evaluated", "branch_pruned"].includes(event.type)
  );
  assert.equal(evaluatedEvents[0].score, 1);
  assert.equal(evaluatedEvents[0].confidence, 0.35);
  assert.equal(evaluatedEvents[1].score, 0);
  assert.equal(Object.hasOwn(evaluatedEvents[1], "confidence"), false);
  assert.equal(validateDocument(result.document).ok, true);
});

test("préserve la provenance fournie par les callbacks dans les hypothèses et preuves", async () => {
  const result = await runTreeReasoning({
    root, criteria: [criteria[0]], budgets: { ...budgets, maxDepth: 1 },
    generate: async () => [{
      statement: "traceable",
      provenance: { source: "fixture-generator", actor: "fixture", recordedAt: "2026-10-10T12:00:00Z" },
      evidence: [{
        source: "fixture-result",
        content: "measured",
        limitations: [],
        provenance: { source: "fixture-evidence", reference: "case-42" },
      }],
    }],
    evaluate: evaluator,
    idFactory: (() => { let n = 0; return () => `provenance-${++n}`; })(),
  });

  const hypothesis = result.document.objects.find(record => record.type === "Hypothesis");
  const evidence = result.document.objects.find(record => record.type === "Evidence");
  assert.equal(hypothesis.provenance.source, "fixture-generator");
  assert.equal(evidence.provenance.source, "fixture-evidence");
  assert.equal(evidence.provenance.reference, "case-42");
});

test("relie les contradictions détectées aux hypothèses et conserve les désaccords", async () => {
  const result = await runTreeReasoning({
    root, criteria, budgets: { ...budgets, maxDepth: 1 },
    generate: async () => ["north", "south"],
    evaluate: evaluator,
    confront: async ({ hypotheses }) => [{
      leftId: hypotheses[0].id,
      rightId: hypotheses[1].id,
    }],
    idFactory: (() => { let n = 0; return () => `conflict-${++n}`; })(),
  });

  const contradiction = result.document.objects.find(record => record.type === "Contradiction");
  assert.ok(contradiction);
  assert.equal(contradiction.status, "open");
  assert.ok(result.disagreements.includes(contradiction.id));
  assert.equal(validateDocument(result.document).ok, true);
});

test("retourne les catégories structurées de confrontation avec leurs références de branche", async () => {
  const result = await runTreeReasoning({
    root, criteria, budgets: { ...budgets, maxDepth: 1 },
    generate: async () => ["north", "south"],
    evaluate: evaluator,
    confront: async ({ hypotheses }) => ({
      agreements: [{ leftId: hypotheses[0].id, rightId: hypotheses[1].id }],
      disagreements: [{ leftId: hypotheses[1].id, rightId: hypotheses[0].id }],
      contradictions: [{ leftId: hypotheses[0].id, rightId: hypotheses[1].id }],
      dominantHypotheses: [hypotheses[0].id],
      underSupportedHypotheses: [hypotheses[1].id],
    }),
    idFactory: (() => { let n = 0; return () => `structured-${++n}`; })(),
  });

  const ids = result.document.objects
    .filter(record => record.type === "Hypothesis")
    .map(record => record.id);
  assert.deepEqual(result.confrontation.agreements, [{
    leftId: ids[0],
    rightId: ids[1],
  }]);
  assert.deepEqual(result.confrontation.disagreements, [{
    leftId: ids[1],
    rightId: ids[0],
  }]);
  assert.deepEqual(result.confrontation.dominantHypotheses, [ids[0]]);
  assert.deepEqual(result.confrontation.underSupportedHypotheses, [ids[1]]);
  assert.equal(result.confrontation.contradictions.length, 1);
  assert.equal(result.disagreements.length, 1);
  assert.ok(result.uncertainties.some(item =>
    item.type === "under_supported_hypothesis" && item.hypothesisId === ids[1]
  ));
  assert.ok(result.trace.some(event => event.type === "agreement_found"));
  assert.ok(result.trace.some(event => event.type === "disagreement_found"));
  assert.ok(result.trace.some(event => event.type === "dominant_hypothesis_identified"));
  assert.ok(result.trace.some(event => event.type === "under_supported_hypothesis_identified"));
});

test("borne les catégories de confrontation et signale explicitement les éléments tronqués", async () => {
  const result = await runTreeReasoning({
    root, criteria,
    budgets: { ...budgets, maxDepth: 1, maxBranches: 3, maxConfrontationItems: 1 },
    generate: async () => ["one", "two", "three"],
    evaluate: evaluator,
    confront: async ({ hypotheses }) => ({
      agreements: [
        { leftId: hypotheses[0].id, rightId: hypotheses[1].id },
        { leftId: hypotheses[0].id, rightId: hypotheses[2].id },
      ],
      dominantHypotheses: [hypotheses[0].id, hypotheses[1].id],
    }),
    idFactory: (() => { let n = 0; return () => `findings-limit-${++n}`; })(),
  });

  assert.equal(result.confrontation.agreements.length, 1);
  assert.equal(result.confrontation.dominantHypotheses.length, 1);
  assert.equal(result.status, "partial");
  assert.ok(result.budgetStops.some(stop => stop.budget === "maxConfrontationItems"));
  assert.ok(result.uncertainties.some(item =>
    item.type === "confrontation_truncated" &&
    item.categories.agreements === 1 &&
    item.categories.dominantHypotheses === 1
  ));
});

test("rejette comme échec de confrontation les références hors de l'expansion", async () => {
  const result = await runTreeReasoning({
    root, criteria, budgets: { ...budgets, maxDepth: 1 },
    generate: async () => ["one", "two"],
    evaluate: evaluator,
    confront: async ({ hypotheses }) => ({
      agreements: [{ leftId: hypotheses[0].id, rightId: "foreign-hypothesis" }],
      disagreements: [],
      contradictions: [],
      dominantHypotheses: [],
      underSupportedHypotheses: [],
    }),
    idFactory: (() => { let n = 0; return () => `invalid-confront-${++n}`; })(),
  });

  assert.equal(result.status, "partial");
  assert.ok(result.errors.some(error =>
    error.stage === "confrontation" &&
    error.message.includes("must reference two distinct hypotheses")
  ));
  assert.deepEqual(result.confrontation.agreements, []);
});

test("retourne explicitement l'absence de candidat viable et ses incertitudes", async () => {
  const result = await runTreeReasoning({
    root, criteria, budgets: { ...budgets, maxDepth: 1 },
    generate: async () => ["unsafe"],
    evaluate: async ({ criteria: requested }) => ({
      evaluatorVersion: "fixture-v1",
      justification: "Required criterion failed",
      results: requested.map(criterion => ({
        criterion: criterion.id,
        outcome: criterion.required ? "fail" : "inconclusive",
      })),
    }),
    idFactory: (() => { let n = 0; return () => `unsafe-${++n}`; })(),
  });

  assert.equal(result.status, "no_viable_candidate");
  assert.equal(result.options.length, 0);
  assert.ok(result.uncertainties.some(item => item.type === "no_viable_candidate"));
});

test("conserve une branche en erreur et poursuit les branches saines", async () => {
  const result = await runTreeReasoning({
    root, criteria, budgets: { ...budgets, maxDepth: 1 },
    generate: async () => ["broken", "healthy"],
    evaluate: async ({ hypothesis }) => {
      if (hypothesis.statement === "broken") throw new Error("fixture evaluator failure");
      return evaluator({ criteria });
    },
    idFactory: (() => { let n = 0; return () => `partial-${++n}`; })(),
  });

  assert.equal(result.status, "partial");
  assert.equal(result.options.length, 1);
  assert.ok(result.errors.some(error => error.stage === "evaluation"));
  assert.ok(result.document.objects.some(record =>
    record.type === "ThoughtNode" && record.status === "failed"));
});

test("annulation externe arrête l'expansion et retourne l'arbre partiel", async () => {
  const controller = new AbortController();
  const resultPromise = runTreeReasoning({
    root, criteria, budgets,
    signal: controller.signal,
    generate: async () => {
      controller.abort();
      return ["candidate"];
    },
    evaluate: evaluator,
    idFactory: () => "cancelled",
  });
  const result = await resultPromise;

  assert.equal(result.status, "cancelled");
  assert.ok(result.uncertainties.some(item => item.type === "cancelled"));
});

test("borne un évaluateur bloqué par timeout et expose les événements observables", async () => {
  const observed = [];
  const result = await runTreeReasoning({
    root,
    criteria,
    budgets: { ...budgets, maxDepth: 1, callTimeoutMs: 20 },
    generate: async () => ["slow"],
    evaluate: () => new Promise(() => {}),
    onEvent: event => observed.push(event.type),
    idFactory: (() => { let n = 0; return () => `slow-${++n}`; })(),
  });

  assert.equal(result.status, "timeout");
  assert.ok(observed.includes("run_stopped"));
  assert.ok(result.trace.length <= 1000);
  assert.ok(result.metrics.elapsedMs < budgets.timeoutMs);
});

test("refuse des critères et budgets invalides plutôt que de les normaliser silencieusement", async () => {
  await assert.rejects(
    runTreeReasoning({
      root, criteria: [], budgets, generate: async () => [], evaluate: evaluator,
    }),
    /criteria must contain/,
  );
  await assert.rejects(
    runTreeReasoning({
      root, criteria, budgets: { ...budgets, maxNodes: 0 },
      generate: async () => [], evaluate: evaluator,
    }),
    /maxNodes/,
  );
});
