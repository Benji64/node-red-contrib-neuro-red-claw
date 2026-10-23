"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { assessDecisionSafety } = require("../../lib/safety-reasoner");
const { SCHEMA_VERSION, validateDocument } = require("../../lib/cognitive-model");

const provenance = { source: "safety-reasoner-test", recordedAt: "2026-10-10T12:00:00.000Z" };

function selectedDocument() {
  return {
    schemaVersion: SCHEMA_VERSION,
    objects: [{
      id: "decision-1",
      type: "Decision",
      provenance,
      options: [{ id: "hypothesis-1", label: "Send a redacted report" }],
      selectedOptionId: "hypothesis-1",
      justification: "highest eligible score",
      uncertainties: [],
      approval: { status: "pending" },
      basis: [],
      status: "selected",
      optionAssessments: [],
    }],
  };
}

test("uses a separate assessor and appends a related, schema-valid safety assessment", async () => {
  const document = selectedDocument();
  const original = structuredClone(document);
  let received;
  const result = await assessDecisionSafety({
    document,
    decisionId: "decision-1",
    assessorId: "safety-model-v2",
    assess: async input => {
      received = input;
      input.decision.justification = "mutated by assessor";
      return {
        decision: "review",
        riskCategories: ["privacy", "external"],
        impact: "medium",
        rulesApplied: ["redaction-required"],
      };
    },
  });

  assert.equal(received.assessorId, "safety-model-v2");
  assert.equal(received.selectedOption.label, "Send a redacted report");
  assert.equal(document.objects[0].justification, original.objects[0].justification);
  assert.equal(result.status, "review");
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.assessment.provenance.source, "safety-reasoner");
  assert.equal(result.assessment.provenance.actor, "safety-model-v2");
  assert.deepEqual(result.assessment.relatedTo, ["decision-1"]);
  assert.equal(validateDocument(result.document).ok, true);
});

test("propagates assessor failures and rejects unsupported assessor fields", async () => {
  const options = {
    document: selectedDocument(),
    decisionId: "decision-1",
    assessorId: "safety-model-v2",
  };
  await assert.rejects(assessDecisionSafety({
    ...options,
    assess: async () => { throw new Error("assessor unavailable"); },
  }), /assessor unavailable/);
  await assert.rejects(assessDecisionSafety({
    ...options,
    assess: async () => ({
      decision: "allow",
      riskCategories: [],
      impact: "low",
      rulesApplied: [],
      selectedOptionId: "another-option",
    }),
  }), /unsupported safety evaluation fields/);
});

test("does not convert an aborted assessor response into an allow disposition", async () => {
  const controller = new AbortController();
  await assert.rejects(assessDecisionSafety({
    document: selectedDocument(),
    decisionId: "decision-1",
    assessorId: "safety-model-v2",
    signal: controller.signal,
    assess: async () => {
      controller.abort();
      return {
        decision: "allow",
        riskCategories: [],
        impact: "low",
        rulesApplied: [],
      };
    },
  }), /assessment cancelled/);
});

test("times out a stalled assessor, aborts it, and emits no safety disposition", async () => {
  let assessorSignal;
  let events = 0;
  await assert.rejects(assessDecisionSafety({
    document: selectedDocument(),
    decisionId: "decision-1",
    assessorId: "safety-model-v2",
    timeoutMs: 10,
    onEvent: () => { events++; },
    assess: async ({ signal }) => {
      assessorSignal = signal;
      return new Promise(() => {});
    },
  }), /timed out after 10 ms/);

  assert.equal(assessorSignal.aborted, true);
  assert.equal(events, 0);
});

test("aborts a pending assessor when its caller cancels", async () => {
  const controller = new AbortController();
  let assessorSignal;
  const pending = assessDecisionSafety({
    document: selectedDocument(),
    decisionId: "decision-1",
    assessorId: "safety-model-v2",
    signal: controller.signal,
    timeoutMs: 1000,
    assess: async ({ signal }) => {
      assessorSignal = signal;
      return new Promise(() => {});
    },
  });
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(pending, /assessment cancelled/);
  assert.equal(assessorSignal.aborted, true);
});

test("bounds the assessor timeout", async () => {
  await assert.rejects(assessDecisionSafety({
    document: selectedDocument(),
    decisionId: "decision-1",
    assessorId: "safety-model-v2",
    timeoutMs: 60_001,
    assess: async () => ({
      decision: "allow",
      riskCategories: [],
      impact: "low",
      rulesApplied: [],
    }),
  }), /timeoutMs must be an integer between 1 and 60000/);
});
