"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildLearningCandidates } = require("../../lib/learning-engine");
const { LearningCandidateStore } = require("../../lib/learning-candidate-store");

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "redclaw-learning-store-"));
}

function candidate() {
  return buildLearningCandidates({
    prediction: { state: "on" },
    outcome: { state: "off" },
    runId: "run-store-1",
    skill: "lighting",
    recordedAt: "2026-10-10T12:00:00.000Z",
  }).candidates[0];
}

test("persists review-only candidates and decisions across store instances", t => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const firstStore = new LearningCandidateStore(directory);
  const pending = firstStore.add(candidate());

  assert.equal(pending.state, "pending_review");
  assert.equal(firstStore.list({ state: "pending_review" }).length, 1);

  const reopenedStore = new LearningCandidateStore(directory);
  const reviewed = reopenedStore.review(pending.id, {
    decision: "approved",
    reviewer: "operator-1",
    reviewedAt: "2026-10-11T09:30:00.000Z",
  });
  assert.equal(reviewed.state, "approved");
  assert.equal(reviewed.active, false);

  const reloadedStore = new LearningCandidateStore(directory);
  assert.deepEqual(reloadedStore.get(pending.id), reviewed);
  assert.equal(reloadedStore.list({ state: "pending_review" }).length, 0);
  assert.equal(reloadedStore.list({ state: "approved" }).length, 1);
  assert.throws(() => reloadedStore.review(pending.id, {
    decision: "rejected",
    reviewer: "operator-2",
  }), /not previously reviewed/);
});

test("creates a versioned, inactive promotion proposal only for an approved candidate", t => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new LearningCandidateStore(directory);
  const pending = store.add(candidate());

  assert.throws(
    () => store.createPromotionProposal(pending.id, "operator-1"),
    /must be approved/,
  );
  store.review(pending.id, {
    decision: "approved",
    reviewer: "reviewer-1",
    reviewedAt: "2026-10-11T09:30:00.000Z",
  });
  const proposal = store.createPromotionProposal(
    pending.id,
    "operator-2",
    "2026-10-12T10:00:00.000Z",
  );

  assert.equal(proposal.schemaVersion, 2);
  assert.equal(proposal.candidateId, pending.id);
  assert.equal(proposal.candidateType, "memory_candidate");
  assert.match(proposal.candidateDigest, /^[a-f0-9]{64}$/);
  assert.match(proposal.proposalDigest, /^[a-f0-9]{64}$/);
  assert.equal(proposal.approvedBy, "reviewer-1");
  assert.equal(proposal.approvedAt, "2026-10-11T09:30:00.000Z");
  assert.deepEqual(proposal.proposedChange, pending.proposedChange);
  assert.equal(proposal.createdBy, "operator-2");
  assert.equal(proposal.status, "prepared");
  assert.equal(proposal.active, false);
  assert.equal(store.get(pending.id).active, false);
  assert.throws(
    () => store.createPromotionProposal(pending.id, "operator-3"),
    /already has a promotion proposal/,
  );

  const reloadedStore = new LearningCandidateStore(directory);
  assert.deepEqual(reloadedStore.listPromotionProposals(), [proposal]);
  assert.equal(reloadedStore.get(pending.id).active, false);
});

test("rejects a corrupted or tampered promotion proposal journal event", t => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new LearningCandidateStore(directory);
  const pending = store.add(candidate());
  store.review(pending.id, {
    decision: "approved",
    reviewer: "reviewer-1",
  });
  const proposal = store.createPromotionProposal(pending.id, "operator-1");
  proposal.proposedChange.content.state = "tampered";
  const events = fs.readFileSync(store.filePath, "utf8").trimEnd().split(/\r?\n/);
  const promotionEvent = JSON.parse(events[2]);
  promotionEvent.proposal.proposedChange = proposal.proposedChange;
  events[2] = JSON.stringify(promotionEvent);
  fs.writeFileSync(store.filePath, `${events.join("\n")}\n`, "utf8");

  assert.throws(
    () => new LearningCandidateStore(directory),
    /invalid learning promotion proposal at line 3/,
  );
});

test("rejects promotion provenance that differs from the candidate approval", t => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new LearningCandidateStore(directory);
  const pending = store.add(candidate());
  store.review(pending.id, {
    decision: "approved",
    reviewer: "reviewer-1",
    reviewedAt: "2026-10-11T09:30:00.000Z",
  });
  store.createPromotionProposal(pending.id, "operator-1");
  const events = fs.readFileSync(store.filePath, "utf8").trimEnd().split(/\r?\n/);
  const promotionEvent = JSON.parse(events[2]);
  promotionEvent.proposal.approvedBy = "forged-reviewer";
  events[2] = JSON.stringify(promotionEvent);
  fs.writeFileSync(store.filePath, `${events.join("\n")}\n`, "utf8");

  assert.throws(
    () => new LearningCandidateStore(directory),
    /invalid learning promotion proposal at line 3/,
  );
});

test("loads and upgrades version 1 promotion proposals with derived approval provenance", t => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new LearningCandidateStore(directory);
  const pending = store.add(candidate());
  store.review(pending.id, {
    decision: "approved",
    reviewer: "reviewer-1",
    reviewedAt: "2026-10-11T09:30:00.000Z",
  });
  store.createPromotionProposal(pending.id, "operator-1");
  const events = fs.readFileSync(store.filePath, "utf8").trimEnd().split(/\r?\n/);
  const promotionEvent = JSON.parse(events[2]);
  promotionEvent.proposal.schemaVersion = 1;
  delete promotionEvent.proposal.approvedBy;
  delete promotionEvent.proposal.approvedAt;
  delete promotionEvent.proposal.proposalDigest;
  events[2] = JSON.stringify(promotionEvent);
  fs.writeFileSync(store.filePath, `${events.join("\n")}\n`, "utf8");

  const migratedProposal = new LearningCandidateStore(directory).listPromotionProposals()[0];
  assert.equal(migratedProposal.schemaVersion, 2);
  assert.equal(migratedProposal.approvedBy, "reviewer-1");
  assert.equal(migratedProposal.approvedAt, "2026-10-11T09:30:00.000Z");
  assert.match(migratedProposal.proposalDigest, /^[a-f0-9]{64}$/);
});

test("rejects edits to proposal metadata using the stored proposal digest", t => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new LearningCandidateStore(directory);
  const pending = store.add(candidate());
  store.review(pending.id, {
    decision: "approved",
    reviewer: "reviewer-1",
  });
  store.createPromotionProposal(pending.id, "operator-1");
  const events = fs.readFileSync(store.filePath, "utf8").trimEnd().split(/\r?\n/);
  const promotionEvent = JSON.parse(events[2]);
  promotionEvent.proposal.createdBy = "forged-operator";
  events[2] = JSON.stringify(promotionEvent);
  fs.writeFileSync(store.filePath, `${events.join("\n")}\n`, "utf8");

  assert.throws(
    () => new LearningCandidateStore(directory),
    /invalid learning promotion proposal at line 3/,
  );
});

test("rejects version 2 proposals with missing provenance or digest fields", t => {
  for (const field of ["approvedBy", "approvedAt", "proposalDigest"]) {
    const directory = temporaryDirectory();
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const store = new LearningCandidateStore(directory);
    const pending = store.add(candidate());
    store.review(pending.id, {
      decision: "approved",
      reviewer: "reviewer-1",
      reviewedAt: "2026-10-11T09:30:00.000Z",
    });
    store.createPromotionProposal(pending.id, "operator-1");
    const events = fs.readFileSync(store.filePath, "utf8").trimEnd().split(/\r?\n/);
    const promotionEvent = JSON.parse(events[2]);
    delete promotionEvent.proposal[field];
    events[2] = JSON.stringify(promotionEvent);
    fs.writeFileSync(store.filePath, `${events.join("\n")}\n`, "utf8");

    assert.throws(
      () => new LearningCandidateStore(directory),
      /invalid learning promotion proposal at line 3/,
      `missing ${field} should invalidate a version 2 proposal`,
    );
  }
});

test("rejects duplicate IDs, unknown candidates, and unsupported filters", t => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new LearningCandidateStore(directory);
  const pending = store.add(candidate());

  assert.throws(() => store.add(pending), /already exists/);
  assert.throws(() => store.review("missing", {
    decision: "approved",
    reviewer: "operator-1",
  }), /not found/);
  assert.throws(() => store.list({ active: false }), /unsupported candidate filters/);
});

test("reports corrupt journals instead of silently dropping review history", t => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "candidates.jsonl");
  fs.writeFileSync(file, `${JSON.stringify({
    event: "candidate_created",
    candidate: candidate(),
  })}\nnot-json\n`, "utf8");

  assert.throws(() => new LearningCandidateStore(directory), /invalid learning candidate journal at line 2/);
});

test("reports structurally invalid journal events with their line number", t => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "candidates.jsonl");
  fs.writeFileSync(file, "{\"event\":\"candidate_created\"}\n", "utf8");

  assert.throws(
    () => new LearningCandidateStore(directory),
    /invalid learning candidate journal event at line 1: candidate must be JSON-serializable/,
  );
});
