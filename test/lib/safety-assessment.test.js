"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSafetyAssessment } = require("../../lib/safety-assessment");
const { validateDocument, SCHEMA_VERSION } = require("../../lib/cognitive-model");
const { Instrumentation } = require("../../lib/instrumentation");

test("creates an independent, schema-valid assessment from the security result", () => {
  const assessment = createSafetyAssessment({
    tool: "send_message",
    evaluation: {
      decision: "review",
      riskCategories: ["privacy", "external"],
      impact: "high",
      rulesApplied: ["send_message"],
    },
  });
  const document = { schemaVersion: SCHEMA_VERSION, objects: [assessment] };
  assert.equal(assessment.type, "SafetyAssessment");
  assert.equal(assessment.decision, "review");
  assert.equal(assessment.escalation, true);
  assert.equal(validateDocument(document).ok, true);
});

test("fails closed on malformed policy output and unsupported risk categories", () => {
  assert.throws(() => createSafetyAssessment({
    tool: "run",
    evaluation: { decision: "unknown" },
  }), /evaluation/);
  assert.throws(() => createSafetyAssessment({
    tool: "run",
    evaluation: { decision: "allow", riskCategories: ["unknown"] },
  }), /risk category/);
  assert.throws(() => createSafetyAssessment({
    tool: "run",
    evaluation: { decision: "review", riskCategories: "privacy" },
  }), /risk category/);
  assert.throws(() => createSafetyAssessment({
    tool: "run",
    evaluation: { decision: "review", rulesApplied: "rule-1" },
  }), /rulesApplied/);
  const repeatedRules = createSafetyAssessment({
    tool: "run",
    evaluation: { decision: "review", rulesApplied: ["rule-1", "rule-1"] },
  });
  assert.deepEqual(repeatedRules.rulesApplied, ["rule-1"]);
  assert.throws(() => createSafetyAssessment({
    tool: "run",
    evaluation: { decision: "review", impact: "" },
  }), /impact/);
});

test("emits an independent safety event that joins the cognitive run trace", () => {
  const instrumentation = new Instrumentation();
  const run = instrumentation.startRun();
  const assessment = createSafetyAssessment({
    tool: "send_message",
    evaluation: {
      decision: "review",
      riskCategories: ["privacy"],
      impact: "high",
      rulesApplied: ["external-message-review"],
    },
    relatedTo: ["hypothesis-1"],
    onEvent: instrumentation.onRunEvent(run),
  });
  const recorded = instrumentation.finishRun(run);
  const [event] = recorded.events;

  assert.equal(event.type, "safety_assessment");
  assert.equal(event.cognitive_role, "safety");
  assert.equal(event.safety_assessment_id, assessment.id);
  assert.equal(event.safety_decision, "review");
  assert.deepEqual(event.safety_risks, ["privacy:high"]);
  assert.deepEqual(event.rules_applied, ["external-message-review"]);
  assert.equal(event.escalation, true);
  assert.deepEqual(event.related_to, ["hypothesis-1"]);
  assert.equal(assessment.decision, "review");
  assert.equal(validateDocument({
    schemaVersion: SCHEMA_VERSION,
    objects: [{
      id: "hypothesis-1",
      type: "Hypothesis",
      provenance: { source: "fixture", recordedAt: "2026-10-10T12:00:00.000Z" },
      statement: "The external message may expose private data",
      status: "proposed",
      dependsOn: [],
    }, assessment],
  }).ok, true);
});

test("validates observer and related references without granting action authority", () => {
  assert.throws(() => createSafetyAssessment({
    tool: "run",
    evaluation: { decision: "allow" },
    onEvent: true,
  }), /onEvent must be a function/);
  assert.throws(() => createSafetyAssessment({
    tool: "run",
    evaluation: { decision: "allow" },
    relatedTo: [" "],
  }), /relatedTo must be an array/);
});
