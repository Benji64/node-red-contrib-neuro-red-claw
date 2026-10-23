"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { decide } = require("../../lib/decision-engine");
const { Instrumentation } = require("../../lib/instrumentation");
const { SCHEMA_VERSION, validateDocument } = require("../../lib/cognitive-model");

const provenance = { source: "decision-engine-test", recordedAt: "2026-10-10T12:00:00.000Z" };

function reasoning({
  candidates = [
    { id: "hyp-a", statement: "Option A", results: ["pass", "pass"], evidence: true },
    { id: "hyp-b", statement: "Option B", results: ["pass", "fail"], evidence: true },
  ],
  status = "completed",
  uncertainties = [],
  disagreements = [],
  confrontation,
} = {}) {
  const objects = [];
  candidates.forEach((candidate, index) => {
    objects.push({
      id: candidate.id,
      type: "Hypothesis",
      provenance,
      statement: candidate.statement,
      status: candidate.status || "proposed",
      dependsOn: [],
      confidence: candidate.confidence ?? 0.7,
    });
    objects.push({
      id: `evaluation-${candidate.id}`,
      type: "Evaluation",
      provenance,
      subjectId: candidate.id,
      criteria: ["quality", "safety"],
      results: candidate.results.map((outcome, resultIndex) => ({
        criterion: resultIndex === 0 ? "quality" : "safety",
        outcome,
        detail: "fixture result",
      })),
      justification: "fixture evaluation rationale",
      evaluatorVersion: "fixture-v1",
    });
    if (candidate.evidence) {
      objects.push({
        id: `evidence-${candidate.id}`,
        type: "Evidence",
        provenance,
        source: "fixture",
        content: `Evidence for ${candidate.id}`,
        limitations: [],
        supports: [candidate.id],
      });
    }
  });
  const result = {
    status,
    document: { schemaVersion: SCHEMA_VERSION, objects },
    options: candidates.map(candidate => ({ hypothesisId: candidate.id })),
    uncertainties,
    disagreements,
  };
  if (confrontation !== undefined) result.confrontation = confrontation;
  return result;
}

function decideFixture(input = reasoning(), policy = {}) {
  return decide({
    reasoning: input,
    policy,
    idFactory: () => "decision-1",
    now: () => Date.parse("2026-10-10T12:01:00.000Z"),
  });
}

test("produit un choix traçable sans autoriser ni lancer une action", () => {
  const result = decideFixture();

  assert.equal(result.status, "selected");
  assert.equal(result.decision.selectedOptionId, "hyp-a");
  assert.equal(result.convergence.selectedHypothesis.hypothesis.id, "hyp-a");
  assert.equal(result.convergence.selectedHypothesis.score, 1);
  assert.equal(result.convergence.confidence, 0.7);
  assert.equal(result.convergence.alternatives.length, 1);
  assert.deepEqual(result.convergence.evidence.map(record => record.id), ["evidence-hyp-a"]);
  assert.deepEqual(result.convergence.sourceBranches, ["hyp-a"]);
  assert.deepEqual(result.decision.basis.sort(), [
    "evaluation-hyp-a", "evaluation-hyp-b", "evidence-hyp-a", "evidence-hyp-b",
  ]);
  assert.equal(result.decision.approval.status, "pending");
  assert.equal(result.executionAuthorized, false);
  assert.equal(validateDocument(result.document).ok, true);
});

test("conserve les contradictions et une trace structurelle sans exposer le texte des branches", () => {
  const input = reasoning();
  input.trace = [{
    type: "branch_created",
    nodeId: "thought-a",
    hypothesisId: "hyp-a",
    hypothesis: "private branch text",
  }];
  input.document.objects.push({
    id: "conflict-1",
    type: "Contradiction",
    provenance,
    leftId: "hyp-a",
    rightId: "hyp-b",
    status: "open",
  });
  const result = decideFixture(input);

  assert.deepEqual(result.convergence.contradictions.map(item => item.id), ["conflict-1"]);
  assert.deepEqual(result.convergence.reasoningTrace, [{
    type: "branch_created",
    nodeId: "thought-a",
    hypothesisId: "hyp-a",
  }]);
});

test("conserve toute l'ascendance des branches sources dans la convergence", () => {
  const input = reasoning();
  const sourceHypotheses = [
    { id: "source-root-a", statement: "Root A", dependsOn: [] },
    { id: "source-root-b", statement: "Root B", dependsOn: [] },
    {
      id: "source-middle",
      statement: "Intermediate hypothesis",
      dependsOn: ["source-root-a", "source-root-b"],
    },
  ];
  input.document.objects.push(...sourceHypotheses.map(hypothesis => ({
    ...hypothesis,
    type: "Hypothesis",
    provenance,
    status: "supported",
  })));
  input.document.objects.find(record => record.id === "hyp-a").dependsOn = ["source-middle"];
  const result = decideFixture(input);

  assert.deepEqual(result.convergence.sourceBranches, [
    "source-root-a",
    "source-root-b",
    "source-middle",
    "hyp-a",
  ]);
  assert.deepEqual(
    result.convergence.selectedHypothesis.sourceBranches,
    result.convergence.sourceBranches
  );
  assert.deepEqual(result.convergence.alternatives[0].sourceBranches, ["hyp-b"]);
});

test("ne retourne aucune branche source quand le Decision Engine s'abstient", () => {
  const input = reasoning({
    candidates: [
      { id: "hyp-a", statement: "Option A", results: ["fail", "fail"], evidence: true },
    ],
  });
  const result = decideFixture(input);

  assert.equal(result.decision.selectedOptionId, null);
  assert.equal(result.convergence.selectedHypothesis, null);
  assert.deepEqual(result.convergence.sourceBranches, []);
  assert.equal(result.convergence.alternatives.length, 1);
});

test("émet un événement décisionnel raccordable à la trace cognitive", () => {
  const instrumentation = new Instrumentation();
  const run = instrumentation.startRun();
  const result = decide({
    reasoning: reasoning(),
    idFactory: () => "decision-1",
    now: () => Date.parse("2026-10-10T12:01:00.000Z"),
    onEvent: instrumentation.onRunEvent(run),
  });
  const recorded = instrumentation.finishRun(run);
  const [event] = recorded.events;

  assert.equal(result.status, "selected");
  assert.equal(event.type, "decision_formed");
  assert.equal(event.cognitive_role, "decision");
  assert.equal(event.decision_id, "decision-1");
  assert.equal(event.decision_status, "selected");
  assert.equal(event.decision_reason, "highest_eligible_score");
  assert.equal(event.selected_option_id, "hyp-a");
  assert.deepEqual(event.option_assessments, result.decision.optionAssessments);
});

test("isole le résultat des mutations faites par l'observateur", () => {
  const result = decide({
    reasoning: reasoning(),
    idFactory: () => "decision-1",
    onEvent(event) {
      event.optionAssessments[0].reason = "observer mutation";
    },
  });

  assert.equal(result.decision.optionAssessments[0].reason, "eligible");
});

test("s'abstient si aucune option ne passe les critères configurés", () => {
  const input = reasoning({
    candidates: [
      { id: "hyp-a", statement: "Option A", results: ["pass", "fail"] },
      { id: "hyp-b", statement: "Option B", results: ["pass", "fail"] },
    ],
  });
  const result = decideFixture(input, { requiredCriteria: ["safety"] });

  assert.equal(result.status, "insufficient_information");
  assert.equal(result.decision.selectedOptionId, null);
  assert.equal(result.decision.optionAssessments[1].reason, "required_criteria_failed");
});

test("représente une absence totale d'options comme information insuffisante", () => {
  const input = reasoning({ candidates: [] });
  const result = decideFixture(input);

  assert.equal(result.status, "insufficient_information");
  assert.deepEqual(result.decision.options, []);
  assert.equal(validateDocument(result.document).ok, true);
});

test("évalue uniquement les hypothèses présentes dans la convergence", () => {
  const input = reasoning();
  input.options = [{ hypothesisId: "hyp-a" }];
  const result = decideFixture(input);

  assert.equal(result.status, "selected");
  assert.deepEqual(result.decision.options.map(option => option.id), ["hyp-a"]);
  assert.deepEqual(result.decision.optionAssessments.map(option => option.optionId), ["hyp-a"]);
});

test("un Tree Reasoner sans candidat viable produit une abstention", () => {
  const input = reasoning({ status: "no_viable_candidate" });
  input.options = [];
  const result = decideFixture(input);

  assert.equal(result.status, "insufficient_information");
  assert.equal(result.reason, "reasoning_no_viable_candidate");
  assert.deepEqual(result.decision.options, []);
});

test("ne départage pas une égalité selon l'ordre des options", () => {
  const input = reasoning({
    candidates: [
      { id: "hyp-a", statement: "Option A", results: ["pass", "pass"], evidence: true },
      { id: "hyp-b", statement: "Option B", results: ["pass", "pass"], evidence: true },
    ],
  });
  const result = decideFixture(input);

  assert.equal(result.status, "tied");
  assert.equal(result.decision.selectedOptionId, null);
  assert.equal(result.decision.justification.includes("without a tie-break"), true);
});

test("départage une égalité uniquement avec un consensus dominant, étayé et sans contradiction", () => {
  const input = reasoning({
    candidates: [
      { id: "hyp-a", statement: "Option A", results: ["pass", "inconclusive"], evidence: true, confidence: 0.86 },
      { id: "hyp-b", statement: "Option B", results: ["pass", "inconclusive"], evidence: true, confidence: 0.87 },
      { id: "hyp-c", statement: "Option C", results: ["pass", "inconclusive"], evidence: true, confidence: 0.85 },
      { id: "hyp-d", statement: "Option D", results: ["pass", "inconclusive"], evidence: true, confidence: 0.9 },
    ],
    confrontation: {
      agreements: [],
      disagreements: [{ leftId: "hyp-a", rightId: "hyp-c" }],
      contradictions: [],
      dominantHypotheses: ["hyp-a", "hyp-b", "hyp-d"],
      underSupportedHypotheses: ["hyp-c"],
    },
  });
  const conservative = decideFixture(input);
  const selected = decideFixture(input, {
    maxUncertainty: 0.5,
    useConsensusTieBreak: true,
  });

  assert.equal(conservative.status, "tied");
  assert.equal(selected.status, "selected");
  assert.equal(selected.decision.selectedOptionId, "hyp-d");
  assert.equal(selected.reason, "dominant_consensus_tie_break");
  assert.match(selected.decision.justification, /dominant and supported set/);
});

test("n'applique pas le départage par consensus lorsqu'une contradiction reste ouverte", () => {
  const input = reasoning({
    candidates: [
      { id: "hyp-a", statement: "Option A", results: ["pass", "pass"], evidence: true },
      { id: "hyp-b", statement: "Option B", results: ["pass", "pass"], evidence: true },
    ],
    confrontation: {
      agreements: [],
      disagreements: [],
      contradictions: [{ leftId: "hyp-a", rightId: "hyp-b" }],
      dominantHypotheses: ["hyp-a", "hyp-b"],
      underSupportedHypotheses: [],
    },
  });
  const result = decideFixture(input, { useConsensusTieBreak: true });

  assert.equal(result.status, "escalation_required");
  assert.equal(result.reason, "unresolved_disagreement");
  assert.equal(result.decision.selectedOptionId, null);
});

test("escalade lorsque l'évaluation contient une forte incertitude", () => {
  const input = reasoning({
    candidates: [
      { id: "hyp-a", statement: "Option A", results: ["pass", "inconclusive"], evidence: true },
      { id: "hyp-b", statement: "Option B", results: ["fail", "fail"] },
    ],
  });
  const result = decideFixture(input, { maxUncertainty: 0.2 });

  assert.equal(result.status, "escalation_required");
  assert.equal(result.decision.selectedOptionId, null);
});

test("escalade sur raisonnement incomplet ou désaccord non résolu", () => {
  const partial = decideFixture(reasoning({ status: "partial" }));
  const disagreement = decideFixture(reasoning({ disagreements: ["conflict-1"] }));

  assert.equal(partial.status, "escalation_required");
  assert.equal(disagreement.reason, "unresolved_disagreement");
  assert.equal(disagreement.decision.selectedOptionId, null);
});

test("escalade sans option quand le raisonnement est interrompu avant tout candidat", () => {
  const result = decideFixture(reasoning({
    status: "timeout",
    candidates: [],
  }));

  assert.equal(result.status, "escalation_required");
  assert.equal(result.reason, "reasoning_timeout");
  assert.deepEqual(result.decision.options, []);
  assert.deepEqual(result.decision.optionAssessments, []);
  assert.equal(validateDocument(result.document).ok, true);
});

test("absence de preuve respecte le minimum configuré et reste traçable", () => {
  const input = reasoning({
    candidates: [{ id: "hyp-a", statement: "Option A", results: ["pass", "pass"] }],
  });
  const result = decideFixture(input, { minEvidence: 1 });

  assert.equal(result.status, "insufficient_information");
  assert.equal(result.decision.optionAssessments[0].reason, "insufficient_evidence");
  assert.deepEqual(result.decision.optionAssessments[0].evidenceIds, []);
});

test("exige une preuve par défaut, sauf dérogation explicite de politique", () => {
  const input = reasoning({
    candidates: [{ id: "hyp-a", statement: "Option A", results: ["pass", "pass"] }],
  });
  const conservative = decideFixture(input);
  const explicitWaiver = decideFixture(input, { minEvidence: 0 });

  assert.equal(conservative.status, "insufficient_information");
  assert.equal(conservative.decision.optionAssessments[0].reason, "insufficient_evidence");
  assert.equal(explicitWaiver.status, "selected");
});

test("refuse des options non évaluées et les références de preuve invalides", () => {
  const missingEvaluation = reasoning({
    candidates: [{ id: "hyp-a", statement: "Option A", results: ["pass", "pass"] }],
  });
  missingEvaluation.document.objects = missingEvaluation.document.objects
    .filter(record => record.type !== "Evaluation");
  assert.equal(decideFixture(missingEvaluation).status, "insufficient_information");

  const invalidEvidence = reasoning();
  invalidEvidence.document.objects.find(record => record.type === "Evidence").supports = ["missing"];
  assert.throws(() => decideFixture(invalidEvidence), /reasoning\.document is invalid/);
});

test("rejette les options d'API inconnues au lieu d'accepter un callback d'exécution", () => {
  let executed = false;
  assert.throws(() => decide({
    reasoning: reasoning(),
    execute() { executed = true; },
  }), /unsupported Decision Engine option/);
  assert.equal(executed, false);
});

test("valide le callback d'observabilité sans le confondre avec une autorisation", () => {
  assert.throws(() => decide({
    reasoning: reasoning(),
    onEvent: true,
  }), /onEvent must be a function/);
});

test("les seuils sont validés et une approbation non requise n'autorise toujours pas l'exécution", () => {
  assert.throws(() => decideFixture(reasoning(), { minMargin: -1 }), /minMargin/);
  assert.throws(() => decideFixture(reasoning(), { useConsensusTieBreak: "yes" }), /useConsensusTieBreak/);
  assert.throws(() => decideFixture(reasoning(), { requiredCriteria: ["unknown"] }), /absent from evaluation/);
  const result = decideFixture(reasoning(), { approvalRequired: false });

  assert.equal(result.decision.approval.status, "not_required");
  assert.equal(result.executionAuthorized, false);
});
