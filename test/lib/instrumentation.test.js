const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Instrumentation } = require("../../lib/instrumentation");
const { runTreeReasoning } = require("../../lib/tree-reasoner");

test("tracks calls, computes aggregates, formats traces, and injects request IDs", () => {
  const instrumentation = new Instrumentation();
  const trace = instrumentation.start("weather", "What is the temperature?", "session-1");

  instrumentation.recordLlm(trace, "Be concise", "It is 21°C", 120);
  instrumentation.recordLlm(trace, "Check source", "Confirmed", 80);
  instrumentation.recordTool(trace, "sensor.read", true, 35);
  instrumentation.recordTool(trace, "sensor.archive", false, 45);
  assert.equal(instrumentation.inject({}, trace).redclaw_request_id, trace.request_id);

  const finished = instrumentation.finish(trace, true);
  assert.equal(finished.steps, 2);
  assert.equal(finished.total_tokens_in, 6);
  assert.equal(finished.total_tokens_out, 6);
  assert.equal(finished.tool_success_rate, 0.5);
  assert.equal(typeof finished.duration_ms, "number");
  assert.match(instrumentation.format(finished), /skill:weather/);
  assert.match(instrumentation.format(finished), /sensor\.read:✓/);
  assert.match(instrumentation.format(finished), /sensor\.archive:✗/);

  assert.deepEqual(instrumentation.stats(), {
    total: 1,
    success_rate: "100%",
    avg_duration_ms: finished.duration_ms,
    avg_tokens_in: 6,
    avg_steps: "2.0",
    top_tools: "sensor.read:1, sensor.archive:1",
  });

  trace.tool_calls[0].tool = "mutated";
  const recent = instrumentation.recent();
  assert.equal(recent[0].tool_calls[0].tool, "sensor.read");
  recent[0].tool_calls[0].tool = "also-mutated";
  assert.equal(instrumentation.recent()[0].tool_calls[0].tool, "sensor.read");
});

test("keeps only the newest entries in the bounded history", () => {
  const instrumentation = new Instrumentation(2);
  for (const skill of ["first", "second", "third"]) {
    instrumentation.finish(instrumentation.start(skill, "request", "session"), true);
  }

  assert.deepEqual(instrumentation.recent().map(trace => trace.skill), ["third", "second"]);
  assert.equal(instrumentation.stats(1).total, 1);
  assert.equal(instrumentation.stats(0), null);
  assert.deepEqual(instrumentation.recent(0), []);
  assert.equal(instrumentation.finish(null, true), null);
  assert.equal(instrumentation.format(null), "");
  assert.equal(instrumentation.inject(null, null), null);
});

test("bounds events per run and exposes trace truncation in the summary", () => {
  const instrumentation = new Instrumentation(2, 2);
  const run = instrumentation.startRun();

  instrumentation.recordRunEvent(run, { type: "first" });
  instrumentation.recordRunEvent(run, { type: "second" });
  assert.equal(instrumentation.recordRunEvent(run, { type: "discarded" }), null);

  const finished = instrumentation.finishRun(run);
  assert.deepEqual(finished.events.map(event => event.type), ["first", "second"]);
  assert.equal(finished.dropped_event_count, 1);
  assert.equal(finished.trace_truncated, true);
  assert.equal(finished.metrics.event_count, 2);
  assert.equal(finished.metrics.dropped_event_count, 1);
  assert.equal(finished.metrics.trace_truncated, true);
  assert.equal(instrumentation.recentRuns()[0].dropped_event_count, 1);
});

test("requires a positive integer event limit", () => {
  assert.throws(() => new Instrumentation(2, 0), /maxEventsPerRun must be a positive integer/);
  assert.throws(() => new Instrumentation(2, 1.5), /maxEventsPerRun must be a positive integer/);
});

test("rejects events and repeated completion after a run is finished", () => {
  const instrumentation = new Instrumentation();
  const otherInstrumentation = new Instrumentation();
  const run = instrumentation.startRun();

  assert.throws(() => otherInstrumentation.recordRunEvent(run, { type: "foreign" }), /active and created by this instrumentation/);
  instrumentation.finishRun(run);
  assert.throws(() => instrumentation.recordRunEvent(run, { type: "late" }), /active and created by this instrumentation/);
  assert.throws(() => instrumentation.finishRun(run), /active and created by this instrumentation/);
  assert.equal(instrumentation.recentRuns()[0].events.length, 0);
});

test("records reconstructible cognitive run events with bounded aggregate metrics", () => {
  const instrumentation = new Instrumentation(2);
  const run = instrumentation.startRun({
    experiment_id: "reasoning-comparison-v1",
    configuration_version: "cfg-3",
    prompt_version: "prompt-2",
    model: "model-a",
    model_role: "evaluator",
    generator_model: "model-generator",
    evaluator_model: "model-evaluator",
    model_version: "2026-10",
    context_version: "ctx-4",
    policy_version: "policy-1",
    contract_version: "cognitive-v1",
    skill_name: "code-review",
    skill_sha256: "a".repeat(64),
    request_id: "request-123",
  });

  const onEvent = instrumentation.onRunEvent(run);
  onEvent({
    type: "branch_created",
    nodeId: "node-2",
    parentId: "root",
    branchId: "branch-2",
    depth: 1,
    cognitiveRole: "reasoning",
    hypothesis: "The sensor is offline",
    confidence: 0.8,
  });
  onEvent({
    type: "branch_pruned",
    nodeId: "node-2",
    depth: 1,
    score: 0.2,
    usage: { tokens: 25, cost: 0.001 },
  });
  onEvent({
    type: "safety_review",
    safetyDecision: "review",
    humanValidation: true,
  });

  const finished = instrumentation.finishRun(run, {
    status: "completed",
    decision: "option-1",
    safety_decision: "review",
    human_validation: true,
    observation: { event: "operator confirmed" },
    outcome: { success: true },
  });

  assert.equal(finished.run_id, run.run_id);
  assert.equal(finished.request_id, "request-123");
  assert.equal(finished.generator_model, "model-generator");
  assert.equal(finished.evaluator_model, "model-evaluator");
  assert.equal(finished.skill_name, "code-review");
  assert.equal(finished.skill_sha256, "a".repeat(64));
  assert.equal(finished.events[0].experiment_id, "reasoning-comparison-v1");
  assert.equal(finished.events[0].skill_name, "code-review");
  assert.equal(finished.events[0].skill_sha256, "a".repeat(64));
  assert.equal(finished.events[0].node_id, "node-2");
  assert.equal(finished.events[0].parent_id, "root");
  assert.equal(finished.events[0].branch_id, "branch-2");
  assert.equal(finished.events[0].model_version, "2026-10");
  assert.equal(finished.events[0].hypothesis, "The sensor is offline");
  assert.equal(finished.events[1].score, 0.2);
  assert.deepEqual(finished.metrics, {
    event_count: 3,
    dropped_event_count: 0,
    trace_truncated: false,
    tokens: 25,
    cost: 0.001,
    tree_depth: 1,
    branch_count: 1,
    pruned_branches: 1,
    contradiction_count: 0,
    safety_interventions: 1,
    human_interventions: 1,
    follow_up_observation_count: 0,
    latency_ms: finished.duration_ms,
  });

  finished.events[0].data.type = "mutated";
  assert.equal(instrumentation.recentRuns()[0].events[0].data.type, "branch_created");
});

test("rejects malformed cognitive run metadata and event inputs", () => {
  const instrumentation = new Instrumentation();
  assert.throws(() => instrumentation.startRun({ model: "" }), /model must be a non-empty string/);
  assert.throws(() => instrumentation.startRun({ unknown: "value" }), /unsupported run metadata/);

  const run = instrumentation.startRun();
  assert.throws(() => instrumentation.recordRunEvent(run, {}), /event\.type/);
  assert.throws(() => instrumentation.finishRun(run, { status: "" }), /status/);
});

test("persists completed cognitive runs and reloads a bounded history", t => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "redclaw-run-store-"));
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));
  const instrumentation = new Instrumentation(2, 10, { storageDir });

  for (let index = 1; index <= 3; index++) {
    const run = instrumentation.startRun({
      experiment_id: `experiment-${index}`,
      ...(index === 3 ? {
        skill_name: "code-review",
        skill_sha256: "c".repeat(64),
      } : {}),
    });
    instrumentation.recordRunEvent(run, { type: "branch_created", depth: index });
    instrumentation.finishRun(run, { status: "completed", outcome: { index } });
  }

  const reopened = new Instrumentation(2, 10, { storageDir });
  const recent = reopened.recentRuns();
  assert.deepEqual(recent.map(run => run.experiment_id), ["experiment-3", "experiment-2"]);
  assert.deepEqual(recent[0].outcome, { index: 3 });
  assert.equal(recent[0].skill_name, "code-review");
  assert.equal(recent[0].skill_sha256, "c".repeat(64));
  assert.equal(recent[0].events[0].depth, 3);
  assert.equal(recent[0].events[0].skill_name, "code-review");
  assert.equal(recent[0].events[0].skill_sha256, "c".repeat(64));
  recent[0].events[0].data.type = "mutated";
  assert.equal(reopened.recentRuns()[0].events[0].data.type, "branch_created");
  assert.equal(fs.readFileSync(path.join(storageDir, "cognitive-runs.jsonl"), "utf8").trim().split(/\r?\n/).length, 3);
});

test("links delayed observation outcomes in a separate durable journal without persisting values", t => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "redclaw-run-followups-"));
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));
  const instrumentation = new Instrumentation(10, 1, { storageDir });
  const run = instrumentation.startRun({ request_id: "request-late-observation" });
  instrumentation.recordRunEvent(run, { type: "request_started" });
  const completed = instrumentation.finishRun(run, {
    status: "completed",
    outcome: { success: true },
  });

  assert.throws(() => instrumentation.recordObservationOutcome("unknown-request", {
    id: "observation-1",
    source: "sensor",
    key: "state",
    ts: Date.now(),
    value: "sensitive-state",
  }), /no completed cognitive run found/);
  assert.throws(() => instrumentation.recordObservationOutcome(completed.request_id, {
    id: "observation-1",
    source: "sensor",
    key: "state",
    ts: Date.now(),
    value: "sensitive-state",
    raw_value: "must-not-be-accepted",
  }), /unsupported observation outcome fields/);

  const followUp = instrumentation.recordObservationOutcome(completed.request_id, {
    id: "observation-1",
    source: "sensor",
    key: "state",
    ts: 1760871300000,
    unit: "state",
    value: "sensitive-state",
  });
  assert.equal(followUp.run_id, completed.run_id);
  assert.equal(followUp.request_id, completed.request_id);
  assert.equal(followUp.causal_attribution, false);
  assert.equal(followUp.observation.value_type, "string");
  assert.equal(Object.hasOwn(followUp.observation, "value"), false);
  assert.equal(instrumentation.recentRuns()[0].events.length, 1);
  assert.equal(instrumentation.recentRuns()[0].metrics.follow_up_observation_count, 1);
  assert.throws(() => instrumentation.recordObservationOutcome(completed.request_id, {
    id: "observation-2",
    source: "sensor",
    key: "state",
    ts: Date.now(),
    value: "later-state",
  }), /follow-up observation limit reached/);

  const runJournal = fs.readFileSync(path.join(storageDir, "cognitive-runs.jsonl"), "utf8");
  const followUpJournal = fs.readFileSync(
    path.join(storageDir, "cognitive-run-followups.jsonl"),
    "utf8"
  );
  assert.equal(runJournal.includes("sensitive-state"), false);
  assert.equal(followUpJournal.includes("sensitive-state"), false);
  assert.equal(runJournal.trim().split(/\r?\n/).length, 1);
  assert.equal(followUpJournal.trim().split(/\r?\n/).length, 1);

  const reopened = new Instrumentation(10, 10, { storageDir });
  const restored = reopened.recentRuns()[0];
  assert.equal(restored.run_id, completed.run_id);
  assert.equal(restored.events.length, 1);
  assert.equal(restored.follow_up_events.length, 1);
  assert.equal(restored.follow_up_events[0].observation.id, "observation-1");
  assert.equal(restored.metrics.follow_up_observation_count, 1);
});

test("ignores valid follow-ups for runs outside the bounded in-memory history", t => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "redclaw-run-followup-retention-"));
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));
  const instrumentation = new Instrumentation(10, 10, { storageDir });
  const oldRun = instrumentation.startRun({ request_id: "older-request" });
  instrumentation.finishRun(oldRun);
  instrumentation.recordObservationOutcome("older-request", {
    id: "old-observation",
    source: "sensor",
    key: "state",
    ts: 1760871300000,
    value: false,
  });
  const recentRun = instrumentation.startRun({ request_id: "recent-request" });
  instrumentation.finishRun(recentRun);

  const reopened = new Instrumentation(1, 10, { storageDir });
  assert.deepEqual(reopened.recentRuns().map(run => run.request_id), ["recent-request"]);
});

test("fails explicitly on corrupt delayed-observation journals", t => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "redclaw-run-followup-corrupt-"));
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));
  const instrumentation = new Instrumentation(10, 10, { storageDir });
  instrumentation.finishRun(instrumentation.startRun({ request_id: "request-1" }));
  fs.writeFileSync(
    path.join(storageDir, "cognitive-run-followups.jsonl"),
    '{"type":"observation_outcome"}\n',
    "utf8"
  );

  assert.throws(
    () => new Instrumentation(10, 10, { storageDir }),
    /invalid cognitive run follow-up journal record at line 1/
  );
});

test("fails explicitly on corrupt cognitive run journals", t => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "redclaw-run-store-"));
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(storageDir, "cognitive-runs.jsonl"), '{"run_id":\n', "utf8");

  assert.throws(
    () => new Instrumentation(10, 10, { storageDir }),
    /invalid cognitive run journal at line 1/
  );
  fs.writeFileSync(
    path.join(storageDir, "cognitive-runs.jsonl"),
    `${JSON.stringify({ run_id: "run-1", request_id: "request-1", status: "completed", events: [], metrics: {}, duration_ms: 0 })}\n`,
    "utf8"
  );
  assert.throws(
    () => new Instrumentation(10, 10, { storageDir }),
    /invalid cognitive run journal record at line 1/
  );
  assert.throws(() => new Instrumentation(10, 10, { storageDir: "" }), /storageDir must be a non-empty path/);
  assert.throws(() => new Instrumentation(10, 10, { unexpected: true }), /may only include storageDir/);
});

test("keeps a run active when durable completion fails", t => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "redclaw-run-store-"));
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));
  const storageFile = path.join(storageDir, "not-a-directory");
  fs.writeFileSync(storageFile, "occupied", "utf8");
  const instrumentation = new Instrumentation(10, 10, { storageDir: storageFile });
  const run = instrumentation.startRun();

  assert.throws(() => instrumentation.finishRun(run), /EEXIST/);
  assert.equal(run.status, "running");
  instrumentation.recordRunEvent(run, { type: "still-active" });
});

test("captures tree-reasoner branch identity, hypothesis, depth, and reported usage", async () => {
  const instrumentation = new Instrumentation();
  const run = instrumentation.startRun({ experiment_id: "tree-fixture" });
  let id = 0;
  const result = await runTreeReasoning({
    root: {
      id: "root",
      branchId: "root",
      parentId: null,
      childIds: [],
      provenance: { source: "fixture", recordedAt: "2026-10-10T12:00:00.000Z" },
    },
    criteria: [{ id: "correctness", weight: 1, required: true }],
    budgets: { maxDepth: 1 },
    generate: async () => ({
      candidates: [{ statement: "Candidate claim", confidence: 0.7 }],
      usage: { tokens: 2, cost: 0.001 },
    }),
    evaluate: async () => ({
      evaluatorVersion: "fixture-v1",
      justification: "The fixture passes",
      results: [{ criterion: "correctness", outcome: "pass" }],
      usage: { tokens: 3, cost: 0.002 },
    }),
    idFactory: prefix => `${prefix}-${++id}`,
    onEvent: instrumentation.onRunEvent(run),
  });

  const finished = instrumentation.finishRun(run, { status: result.status });
  const created = finished.events.find(event => event.type === "branch_created");
  assert.equal(created.node_id, "thought-2");
  assert.equal(created.parent_id, "root");
  assert.equal(created.branch_id, "hypothesis-1");
  assert.equal(created.depth, 1);
  assert.equal(created.cognitive_role, "reasoning");
  assert.equal(created.hypothesis, "Candidate claim");
  assert.equal(finished.metrics.tokens, 5);
  assert.equal(finished.metrics.cost, 0.003);
});
