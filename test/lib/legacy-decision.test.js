"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { selectLegacyDecision } = require("../../lib/legacy-decision");

test("selects a tool proposal without changing its tool arguments", () => {
  const proposal = {
    action: "tool",
    tool: "turn_on",
    params: { lamp: "living-room" },
  };

  assert.deepEqual(selectLegacyDecision(proposal, "ignored"), {
    action: "tool",
    tool: "turn_on",
    params: { lamp: "living-room" },
    status: "selected",
    reason: "legacy_tool_proposal_selected",
  });
});

test("abstains from malformed tool proposals", () => {
  for (const proposal of [
    { action: "tool", params: {} },
    { action: "tool", tool: "turn_on", params: [] },
    { action: "tool", tool: "turn_on", params: null },
  ]) {
    assert.deepEqual(selectLegacyDecision(proposal, "raw proposal"), {
      action: "respond",
      response: "La proposition d'action est invalide et n'a pas été exécutée.",
      status: "abstained",
      reason: "invalid_tool_proposal",
    });
  }
});

test("normalizes tool names and supplies empty params for valid minimal proposals", () => {
  assert.deepEqual(selectLegacyDecision({
    action: "tool",
    tool: "  turn_on  ",
  }, "ignored"), {
    action: "tool",
    tool: "turn_on",
    params: {},
    status: "selected",
    reason: "legacy_tool_proposal_selected",
  });
});

test("selects only tools declared by the skill when an allowlist is configured", () => {
  const proposal = { action: "tool", tool: "turn_on", params: {} };
  assert.equal(selectLegacyDecision(proposal, "", " turn_on, turn_off ").action, "tool");
  assert.equal(selectLegacyDecision(
    { ...proposal, tool: "delete_all" },
    "ignored",
    "turn_on, turn_off"
  ).reason, "tool_not_declared_by_skill");
  assert.equal(selectLegacyDecision(proposal, "", "").action, "tool");
  assert.equal(selectLegacyDecision(proposal, "", "", true).reason,
    "no_tools_declared_by_skill");
  assert.equal(selectLegacyDecision(proposal, "", "turn_on", true).action, "tool");
  assert.throws(
    () => selectLegacyDecision(proposal, "", ["turn_on"]),
    /configuredTools must be a comma-separated string/
  );
  assert.throws(
    () => selectLegacyDecision(proposal, "", "turn_on", "yes"),
    /strictToolAllowlist must be a boolean/
  );
});

test("selects explicit responses and retains historical fallback behavior", () => {
  assert.deepEqual(selectLegacyDecision(
    { action: "respond", message: "  Done  " },
    "raw response"
  ), {
    action: "respond",
    response: "Done",
    status: "selected",
    reason: "legacy_response_selected",
  });
  assert.equal(selectLegacyDecision(null, " raw ").response, "raw");
  assert.equal(selectLegacyDecision({ action: "unknown" }, " raw ").reason,
    "unsupported_action_response_fallback");
});
