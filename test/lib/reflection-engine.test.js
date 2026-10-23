const test = require("node:test");
const assert = require("node:assert/strict");
const { ReflectionEngine } = require("../../lib/reflection-engine");

test("returns an empty report for missing tickets", () => {
  const engine = new ReflectionEngine();
  assert.deepEqual(engine.analyze([]), {
    insights: [],
    stats: null,
    patterns: [],
    prescriptions: [],
  });
  assert.deepEqual(engine.analyze(null).patterns, []);
});

test("computes stats, detects repeated failures, and creates actionable prescriptions", () => {
  const engine = new ReflectionEngine();
  const tickets = Array.from({ length: 5 }, (_, index) => ({
    status: index === 0 ? "completed" : "failed",
    skill: "weather",
    duration_ms: 12000,
    tokens_in: 400,
    steps: [1, 2, 3, 4, 5],
    tool_calls: [{ tool: "sensor.read", success: index === 0 }],
  }));

  const report = engine.analyze(tickets);
  assert.equal(report.ticketCount, 5);
  assert.equal(report.stats.total, 5);
  assert.equal(report.stats.completed, 1);
  assert.equal(report.stats.failed, 4);
  assert.equal(report.stats.successRate, 20);
  assert.equal(report.stats.avgDuration, 12000);
  assert.equal(report.stats.avgTokens, 400);
  assert.equal(report.stats.avgSteps, 5);
  assert.deepEqual(report.stats.topTools, ["sensor.read(5)"]);
  assert.deepEqual(report.stats.failedTools, ["sensor.read"]);
  assert.ok(report.patterns.some(pattern => pattern.type === "high_failure_rate"));
  assert.ok(report.patterns.some(pattern => pattern.type === "failing_tools"));
  assert.ok(report.patterns.some(pattern => pattern.type === "slow_responses"));
  assert.ok(report.patterns.some(pattern => pattern.type === "excessive_steps"));
  assert.ok(report.prescriptions.some(item => item.type === "skill_context"));
  assert.ok(report.insights.some(insight => insight.includes("Taux de succès faible")));
});

test("builds a reflection prompt with summary, patterns, and response format", () => {
  const engine = new ReflectionEngine();
  const prompt = engine.buildReflectionPrompt([
    {
      status: "completed",
      skill: "weather",
      duration_ms: 100,
      tokens_in: 80,
      steps: [1],
      tool_calls: [{ tool: "sensor.read", success: true }],
    },
  ], "weather");

  assert.match(prompt, /agent "weather"/);
  assert.match(prompt, /Taux de succès : 100%/);
  assert.match(prompt, /Tools les plus utilisés : sensor\.read\(1\)/);
  assert.match(prompt, /"observations"/);
});
