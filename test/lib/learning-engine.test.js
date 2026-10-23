const test = require("node:test");
const assert = require("node:assert/strict");
const { buildLearningCandidates, reviewLearningCandidate } = require("../../lib/learning-engine");

test("compares prediction with observed outcome and creates review-only memory candidates", () => {
  const result = buildLearningCandidates({
    prediction: { state: "on", level: 1 },
    outcome: { level: 1, state: "off" },
    runId: "run-1",
    skill: "lighting",
    recordedAt: "2026-10-10T12:00:00.000Z",
  });

  assert.equal(result.predictionOutcome.matches, false);
  assert.equal(result.predictionOutcome.runId, "run-1");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].type, "memory_candidate");
  assert.equal(result.candidates[0].state, "pending_review");
  assert.equal(result.candidates[0].active, false);
  assert.equal(result.candidates[0].requiresHumanApproval, true);
  assert.deepEqual(result.candidates[0].proposedChange.content, { level: 1, state: "off" });
});

test("retains an observation correlation without attributing causality", () => {
  const result = buildLearningCandidates({
    prediction: { state: "on" },
    outcome: { state: "off" },
    runId: "run-1",
    correlatedObservation: {
      observationId: "observation-1",
      requestId: "request-1",
    },
  });

  assert.deepEqual(result.predictionOutcome.correlatedObservation, {
    observationId: "observation-1",
    requestId: "request-1",
    causalAttribution: false,
  });
  assert.deepEqual(result.candidates[0].correlatedObservation, {
    observationId: "observation-1",
    requestId: "request-1",
    causalAttribution: false,
  });
});

test("converts reflection suggestions to typed candidates without activating changes", () => {
  const result = buildLearningCandidates({
    adjustments: [
      { type: "skill_context", target: "lighting", suggestion: "Add an observed example" },
      { type: "policy", target: "turn_on", suggestion: "Require confirmation" },
      { type: "mcp_adapter", target: "turn_on", suggestion: "Check result mapping" },
    ],
    skill: "lighting",
  });

  assert.deepEqual(result.candidates.map(candidate => candidate.type), [
    "skill_candidate",
    "policy_candidate",
    "configuration_candidate",
  ]);
  assert.ok(result.candidates.every(candidate =>
    candidate.active === false &&
    candidate.state === "pending_review" &&
    candidate.requiresHumanApproval === true
  ));
});

test("rejects incomplete or malformed learning evidence", () => {
  assert.throws(
    () => buildLearningCandidates({ prediction: { state: "on" } }),
    /supplied together/,
  );
  assert.throws(
    () => buildLearningCandidates({ adjustments: [{ type: "policy" }] }),
    /suggestion must be a non-empty string/,
  );
  assert.throws(
    () => buildLearningCandidates({ prediction: undefined, outcome: null }),
    /JSON-serializable/,
  );
  assert.throws(
    () => buildLearningCandidates({ prediction: { confidence: Number.NaN }, outcome: {} }),
    /JSON-compatible values/,
  );
  assert.throws(
    () => buildLearningCandidates({
      adjustments: [],
      correlatedObservation: { observationId: "observation-1" },
    }),
    /correlatedObservation.requestId must be a non-empty string/,
  );
});

test("records an explicit human review without activating an approved candidate", () => {
  const candidate = buildLearningCandidates({
    adjustments: [{ type: "skill_context", target: "lighting", suggestion: "Add an observed example" }],
    skill: "lighting",
    runId: "run-42",
    recordedAt: "2026-10-10T12:00:00.000Z",
  }).candidates[0];

  const reviewed = reviewLearningCandidate(candidate, {
    decision: "approved",
    reviewer: "operator-7",
    reviewedAt: "2026-10-11T09:30:00.000Z",
  });

  assert.equal(candidate.state, "pending_review");
  assert.equal(candidate.active, false);
  assert.equal(reviewed.state, "approved");
  assert.equal(reviewed.active, false);
  assert.equal(reviewed.requiresHumanApproval, false);
  assert.deepEqual(reviewed.review, {
    decision: "approved",
    reviewer: "operator-7",
    reviewedAt: "2026-10-11T09:30:00.000Z",
  });
  assert.equal(reviewed.proposedChange.suggestion, "Add an observed example");
});

test("records rejection and disallows replay or malformed review decisions", () => {
  const candidate = buildLearningCandidates({
    prediction: { answer: 1 },
    outcome: { answer: 2 },
    recordedAt: "2026-10-10T12:00:00.000Z",
  }).candidates[0];
  const rejected = reviewLearningCandidate(candidate, {
    decision: "rejected",
    reviewer: "operator-8",
    reviewedAt: "2026-10-11T09:30:00.000Z",
  });

  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.active, false);
  assert.throws(() => reviewLearningCandidate(rejected, {
    decision: "approved",
    reviewer: "operator-9",
  }), /not previously reviewed/);
  assert.throws(() => reviewLearningCandidate(candidate, {
    decision: "approved",
    reviewer: " ",
  }), /reviewer must be a non-empty string/);
  assert.throws(() => reviewLearningCandidate(candidate, {
    decision: "approved",
    reviewer: "operator-9",
    unexpected: true,
  }), /unsupported review fields/);
  assert.throws(() => reviewLearningCandidate(candidate, {
    decision: "approved",
    reviewer: "operator-9",
    reviewedAt: "not-a-date",
  }), /valid date string/);
});
