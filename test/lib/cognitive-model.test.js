"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SCHEMA_VERSION,
  TYPES,
  validateDocument,
  serializeDocument,
  deserializeDocument,
} = require("../../lib/cognitive-model");

const provenance = { source: "unit-test", recordedAt: "2026-10-10T12:00:00.000Z" };

function validDocument() {
  return {
    schemaVersion: SCHEMA_VERSION,
    objects: [
      {
        id: "thought-root", type: "ThoughtNode", provenance, parentId: null,
        childIds: ["thought-child"], branchId: "branch-1", status: "active",
      },
      {
        id: "thought-child", type: "ThoughtNode", provenance, parentId: "thought-root",
        childIds: [], branchId: "branch-1", status: "pending",
      },
      {
        id: "hypothesis-1", type: "Hypothesis", provenance, statement: "The change is safe",
        status: "proposed", dependsOn: [], confidence: 0.7,
      },
      {
        id: "evidence-1", type: "Evidence", provenance, source: "test-run",
        content: "All focused tests pass", limitations: ["No production traffic covered"],
        supports: ["hypothesis-1"],
      },
      {
        id: "contradiction-1", type: "Contradiction", provenance,
        leftId: "hypothesis-1", rightId: "thought-child", status: "resolved",
        resolutionId: "evaluation-1",
      },
      {
        id: "evaluation-1", type: "Evaluation", provenance, subjectId: "hypothesis-1",
        criteria: ["reproducible"], results: [{ criterion: "reproducible", outcome: "pass" }],
        justification: "The regression test reproduces the required behavior",
        evaluatorVersion: "rules-v1",
      },
      {
        id: "decision-1", type: "Decision", provenance,
        options: [{ id: "ship", label: "Ship" }, { id: "hold", label: "Hold" }],
        selectedOptionId: "ship", justification: "Evidence satisfies the defined criteria",
        uncertainties: [], approval: { status: "approved", approver: "reviewer-1", approvedAt: "2026-10-10T12:01:00Z" },
        basis: ["evidence-1", "evaluation-1", "contradiction-1"],
      },
      {
        id: "safety-1", type: "SafetyAssessment", provenance, risks: [],
        rulesApplied: ["least-privilege"], decision: "allow", escalation: false,
        relatedTo: ["decision-1"],
      },
      {
        id: "observation-1", type: "Observation", provenance,
        event: "The test suite completed", interpretation: null, relatedTo: ["thought-root"],
      },
    ],
  };
}

test("expose les huit types de données cognitives versionnés", () => {
  assert.deepEqual(TYPES, [
    "ThoughtNode", "Hypothesis", "Evidence", "Contradiction", "Evaluation",
    "Decision", "SafetyAssessment", "Observation",
  ]);
  assert.equal(validateDocument(validDocument()).ok, true);
});

test("allows empty decision options for an escalation without candidates", () => {
  const document = validDocument();
  const decision = document.objects.find(record => record.type === "Decision");
  decision.options = [];
  decision.selectedOptionId = null;
  decision.status = "escalation_required";
  decision.optionAssessments = [];
  decision.approval = { status: "pending" };
  decision.basis = [];

  assert.equal(validateDocument(document).ok, true);
});

test("still requires options for a tied decision", () => {
  const document = validDocument();
  const decision = document.objects.find(record => record.type === "Decision");
  decision.options = [];
  decision.selectedOptionId = null;
  decision.status = "tied";
  decision.optionAssessments = [];
  decision.approval = { status: "pending" };
  decision.basis = [];

  assert.match(
    validateDocument(document).errors.join("; "),
    /options must be non-empty unless status is insufficient_information or escalation_required/,
  );
});

test("rejette les champs requis manquants, les états invalides et les références inconnues", () => {
  const document = validDocument();
  delete document.objects[2].statement;
  document.objects[3].supports = ["missing-hypothesis"];
  document.objects[6].approval = { status: "approved", approver: "reviewer-1" };
  const result = validateDocument(document);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes("statement")));
  assert.ok(result.errors.some(error => error.includes("unknown id")));
  assert.ok(result.errors.some(error => error.includes("requires approver and approvedAt")));
});

test("rejette les identifiants de record dupliqués et les références incohérentes", () => {
  const document = validDocument();
  document.objects[1].id = "thought-root";
  const result = validateDocument(document);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes("duplicates")));
});

test("valide les liens parent/enfant et rejette les cycles de pensée", () => {
  const document = validDocument();
  document.objects[1].parentId = "thought-child";
  document.objects[1].childIds = ["thought-root"];
  const result = validateDocument(document);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes("parent cycle")));
});

test("rejette une contradiction résolue sans référence de résolution", () => {
  const document = validDocument();
  delete document.objects[4].resolutionId;
  const result = validateDocument(document);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes("resolutionId is required")));
});

test("rejette les preuves ambiguës et les identifiants d'options dupliqués", () => {
  const document = validDocument();
  document.objects[3].reference = { uri: "https://example.invalid/evidence" };
  document.objects[6].options[1].id = "ship";
  const result = validateDocument(document);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes("exactly one of content or reference")));
  assert.ok(result.errors.some(error => error.includes("options[1].id is duplicated")));
});

test("renvoie une erreur de validation pour une référence d'évidence mal formée", () => {
  const document = validDocument();
  delete document.objects[3].content;
  document.objects[3].reference = null;
  const result = validateDocument(document);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes("reference must be a plain object")));
});

test("rejette les versions inconnues et les champs non définis par le schéma", () => {
  const unsupportedVersion = validDocument();
  unsupportedVersion.schemaVersion = 2;
  assert.match(validateDocument(unsupportedVersion).errors.join("; "), /schemaVersion must be 1/);

  const extraField = validDocument();
  extraField.objects[0].privateNotes = "must not be silently persisted";
  assert.match(validateDocument(extraField).errors.join("; "), /privateNotes is not a supported field/);
});

test("rejette les noms de type hérités du prototype JavaScript", () => {
  const document = {
    schemaVersion: SCHEMA_VERSION,
    objects: [{ id: "bad", type: "toString" }],
  };

  assert.equal(validateDocument(document).ok, false);
  document.objects[0].type = "__proto__";
  assert.equal(validateDocument(document).ok, false);
});

test("rejette les objets non JSON et les accesseurs sans les exécuter", () => {
  const document = validDocument();
  let getterCalled = false;
  Object.defineProperty(document.objects[0], "branchId", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "branch-1";
    },
  });

  const result = validateDocument(document);
  assert.equal(result.ok, false);
  assert.equal(getterCalled, false);
  assert.ok(result.errors.some(error => error.includes("data property")));
});

test("sérialise et restaure un document en préservant liens et provenance", () => {
  const original = validDocument();
  const restored = deserializeDocument(serializeDocument(original));

  assert.deepEqual(restored, original);
  assert.deepEqual(restored.objects[3].supports, ["hypothesis-1"]);
  assert.equal(restored.objects[3].provenance.source, "unit-test");
});

test("valide les états explicites de décision et les évaluations liées aux options", () => {
  const document = validDocument();
  const decision = document.objects[6];
  decision.status = "selected";
  decision.optionAssessments = [{
    optionId: "ship",
    score: 0.9,
    uncertainty: 0.1,
    eligible: true,
    reason: "eligible",
    evidenceIds: ["evidence-1"],
    evaluationIds: ["evaluation-1"],
  }];
  assert.equal(validateDocument(document).ok, true);

  decision.status = "tied";
  const invalid = validateDocument(document);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some(error => error.includes("requires selectedOptionId to be null")));
});

test("accepte une approbation non requise sans la confondre avec une autorisation", () => {
  const document = validDocument();
  document.objects[6].approval = { status: "not_required" };
  assert.equal(validateDocument(document).ok, true);
});

test("signale explicitement JSON invalide et document non valide au chargement", () => {
  assert.throws(() => deserializeDocument("{"), SyntaxError);
  assert.throws(
    () => deserializeDocument(JSON.stringify({ schemaVersion: 99, objects: [] })),
    /schemaVersion must be 1/,
  );
  assert.throws(() => serializeDocument({ schemaVersion: 1, objects: [], unsupported: true }), /not a supported field/);
});
