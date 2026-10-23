"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { assessToolSafety } = require("../../lib/safety-model-assessor");

test("safety tool assessor returns a validated, normalized disposition", async () => {
  let request;
  const result = await assessToolSafety({
    async chat(system, user, options) {
      request = { system, user: JSON.parse(user), options };
      return '```json\n{"decision":"review","riskCategories":["privacy"],"impact":"medium","rulesApplied":["redact"]}\n```';
    },
  }, {
    tool: "send_report",
    params: { target: "operator" },
    riskCategories: ["technical"],
    impact: "low",
    rulesApplied: ["send_report"],
  });

  assert.equal(result.decision, "review");
  assert.deepEqual(result.riskCategories, ["privacy"]);
  assert.deepEqual(request.user.params, { target: "operator" });
  assert.match(request.system, /not an execution authority/);
  assert.equal(request.options.temperature, 0);
});

test("safety tool assessor forwards its cancellation signal to the LLM client", async () => {
  const controller = new AbortController();
  let receivedSignal;
  await assessToolSafety({
    async chat(_system, _user, options) {
      receivedSignal = options.signal;
      return JSON.stringify({
        decision: "allow",
        riskCategories: ["technical"],
        impact: "low",
        rulesApplied: [],
      });
    },
  }, {
    tool: "read",
    params: {},
    signal: controller.signal,
  });

  assert.equal(receivedSignal, controller.signal);
});

test("safety tool assessor rejects invalid or authority-expanding responses", async () => {
  for (const response of [
    "not-json",
    JSON.stringify({
      decision: "allow",
      riskCategories: [],
      impact: "low",
      rulesApplied: [],
      executionAuthorized: true,
    }),
    JSON.stringify({
      decision: "allow",
      riskCategories: ["unknown"],
      impact: "low",
      rulesApplied: [],
    }),
  ]) {
    await assert.rejects(assessToolSafety({
      async chat() { return response; },
    }, { tool: "read", params: {} }));
  }
});
