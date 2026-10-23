"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runFixture } = require("../../examples/cognitive-run-fixture");
const { assessDecisionSafety } = require("../../lib/safety-reasoner");
const { SCHEMA_VERSION } = require("../../lib/cognitive-model");
const { LearningCandidateStore } = require("../../lib/learning-candidate-store");

test("connects reasoning, decision, safety, observation, learning, and trace without authorizing execution", async () => {
  const {
    reasoning,
    decisionResult,
    safetyAssessment,
    observation,
    learning,
    document,
    recordedRun,
  } = await runFixture();
  const eventTypes = recordedRun.events.map(event => event.type);

  assert.equal(reasoning.status, "completed");
  assert.equal(decisionResult.status, "selected");
  assert.equal(safetyAssessment.decision, "review");
  assert.equal(decisionResult.executionAuthorized, false);
  assert.equal(recordedRun.decision, decisionResult.decision.selectedOptionId);
  assert.equal(recordedRun.safety_decision, "review");
  assert.ok(eventTypes.includes("branch_created"));
  assert.ok(eventTypes.includes("branch_pruned"));
  assert.ok(eventTypes.includes("decision_formed"));
  assert.ok(eventTypes.includes("safety_assessment"));
  assert.ok(eventTypes.includes("learning_candidate_created"));
  assert.equal(recordedRun.events.every(event =>
    event.run_id === recordedRun.run_id &&
    event.request_id === recordedRun.request_id), true);
  assert.equal(document.objects.some(record =>
    record.id === safetyAssessment.id && record.type === "SafetyAssessment"), true);
  assert.equal(safetyAssessment.provenance.source, "safety-reasoner");
  assert.equal(safetyAssessment.provenance.actor, "independent-safety-fixture");
  assert.equal(observation.type, "Observation");
  assert.deepEqual(observation.relatedTo, [decisionResult.decision.id, safetyAssessment.id]);
  assert.equal(recordedRun.observation.event, observation.event);
  assert.equal(learning.predictionOutcome.matches, false);
  assert.equal(learning.predictionOutcome.runId, recordedRun.run_id);
  assert.equal(learning.candidates.length, 1);
  assert.equal(learning.candidates[0].state, "pending_review");
  assert.equal(learning.candidates[0].active, false);
  assert.equal(learning.candidates[0].requiresHumanApproval, true);
  assert.equal(learning.candidates[0].runId, recordedRun.run_id);
});

test("safety reasoning fails closed on abstained decisions and malformed assessor results", async () => {
  const document = {
    schemaVersion: SCHEMA_VERSION,
    objects: [{
      id: "decision-abstained",
      type: "Decision",
      provenance: { source: "fixture", recordedAt: "2026-10-10T12:00:00.000Z" },
      options: [{ id: "hypothesis-1", label: "Option" }],
      selectedOptionId: null,
      justification: "insufficient information",
      uncertainties: [],
      approval: { status: "pending" },
      basis: [],
      status: "insufficient_information",
      optionAssessments: [],
    }],
  };

  await assert.rejects(assessDecisionSafety({
    document,
    decisionId: "decision-abstained",
    assessorId: "safety-model-v1",
    assess: async () => ({
      decision: "allow",
      riskCategories: [],
      impact: "low",
      rulesApplied: [],
    }),
  }), /requires a selected Decision/);

  const selected = {
    ...document,
    objects: [{
      ...document.objects[0],
      selectedOptionId: "hypothesis-1",
      status: "selected",
    }],
  };
  await assert.rejects(assessDecisionSafety({
    document: selected,
    decisionId: "decision-abstained",
    assessorId: "safety-model-v1",
    assess: async () => ({ decision: "allow", riskCategories: "privacy" }),
  }), /riskCategories/);
});

test("safety allow, review, and deny results never authorize execution", async () => {
  const { decisionResult } = await runFixture();
  for (const safetyDecision of ["allow", "review", "deny"]) {
    const result = await assessDecisionSafety({
      document: decisionResult.document,
      decisionId: decisionResult.decision.id,
      assessorId: "safety-model-v1",
      assess: async () => ({
        decision: safetyDecision,
        riskCategories: [],
        impact: "low",
        rulesApplied: [],
      }),
    });
    assert.equal(result.status, safetyDecision);
    assert.equal(result.executionAuthorized, false);
  }
});

test("persists the integrated run candidate and human review without activation", async t => {
  const { learning, recordedRun } = await runFixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "redclaw-integrated-learning-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new LearningCandidateStore(directory);
  const [pending] = learning.candidates.map(candidate => store.add(candidate));
  const reopenedStore = new LearningCandidateStore(directory);
  const reviewed = reopenedStore.review(pending.id, {
    decision: "approved",
    reviewer: "fixture-reviewer",
    reviewedAt: "2026-10-10T12:00:03.000Z",
  });
  const reloadedStore = new LearningCandidateStore(directory);
  const persisted = reloadedStore.get(pending.id);

  assert.equal(pending.runId, recordedRun.run_id);
  assert.equal(persisted.state, "approved");
  assert.equal(persisted.active, false);
  assert.equal(persisted.review.reviewer, "fixture-reviewer");
  assert.equal(reloadedStore.list({ state: "pending_review" }).length, 0);
  assert.equal(reloadedStore.list({ state: "approved" }).length, 1);
  assert.equal(reviewed.active, false);
});
