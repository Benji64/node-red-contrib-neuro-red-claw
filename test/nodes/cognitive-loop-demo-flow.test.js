"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const flowPath = path.join(root, "examples", "cognitive-loop-demo.json");
const packagePath = path.join(root, "package.json");

function loadFlow() {
  return JSON.parse(fs.readFileSync(flowPath, "utf8"));
}

describe("importable Copilot + ShieldGemma RedClaw assistant flow", () => {
  it("is valid JSON with unique IDs, valid wires, and every package palette node", () => {
    const flow = loadFlow();
    const nodes = new Map(flow.map(node => [node.id, node]));
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    const paletteTypes = Object.keys(packageJson["node-red"].nodes);
    const flowTypes = new Set(flow.map(node => node.type));
    const configTypes = new Set([
      "llm-config",
      "embed-config",
      "redclaw-policy-config",
      "ui-base",
      "ui-theme",
      "ui-page",
      "ui-group",
    ]);

    assert.equal(nodes.size, flow.length, "node IDs must be unique");
    assert.equal(flow.filter(node => node.type === "tab").length, 1);
    assert.equal(
      flow.find(node => node.type === "tab").label,
      "RedClaw - assistant local Ollama",
    );

    for (const type of paletteTypes) {
      assert.ok(flowTypes.has(type), `flow must include palette type ${type}`);
    }

    for (const node of flow) {
      if (node.type !== "tab" && !configTypes.has(node.type)) {
        assert.ok(nodes.has(node.z), `${node.id} must belong to an imported tab`);
      }
      for (const output of node.wires || []) {
        for (const targetId of output) {
          assert.ok(nodes.has(targetId), `${node.id} references missing node ${targetId}`);
        }
      }
      if (node.type === "function") {
        assert.doesNotThrow(() => new Function("msg", "flow", "node", node.func), node.id);
      }
    }
  });

  it("connects Chat, Hub, the Copilot child orchestrator, and the return path", () => {
    const flow = loadFlow();
    const byId = Object.fromEntries(flow.map(node => [node.id, node]));

    assert.deepEqual(byId["redclaw-demo-chat"].wires[1], ["redclaw-demo-shield-input-prepare"]);
    assert.deepEqual(byId["redclaw-demo-shield-input-evaluate"].wires[0], ["redclaw-demo-envelope"]);
    assert.deepEqual(byId["redclaw-demo-envelope"].wires[0], ["redclaw-demo-hub-request"]);
    assert.deepEqual(byId["redclaw-demo-hub"].wires, [
      ["redclaw-demo-context"],
      ["redclaw-demo-shield-output-prepare"],
    ]);
    assert.deepEqual(byId["redclaw-demo-context"].wires[0], ["redclaw-demo-longterm"]);
    assert.deepEqual(byId["redclaw-demo-longterm"].wires[0], ["redclaw-demo-skill"]);
    assert.deepEqual(byId["redclaw-demo-skill"].wires[0], ["redclaw-demo-embed"]);
    assert.deepEqual(byId["redclaw-demo-chat"].wires[3], ["redclaw-demo-assistance-ui"]);
    assert.deepEqual(byId["redclaw-demo-embed"].wires, [
      ["redclaw-demo-orchestrator"],
      ["redclaw-demo-embed-fallback"],
    ]);
    assert.deepEqual(byId["redclaw-demo-embed-fallback"].wires, [
      ["redclaw-demo-orchestrator"],
      ["redclaw-demo-chat"],
    ]);
    assert.deepEqual(byId["redclaw-demo-orchestrator"].wires, [
      ["redclaw-demo-unexpected-tool"],
      ["redclaw-demo-hub"],
      ["redclaw-demo-copilot-prompt-adapter"],
      ["redclaw-demo-response-review"],
    ]);
    assert.deepEqual(byId["redclaw-demo-copilot-prompt-adapter"].wires, [
      ["redclaw-demo-copilot"],
    ]);
    assert.deepEqual(byId["redclaw-demo-copilot"].wires, [["redclaw-demo-orchestrator"]]);
    assert.deepEqual(byId["redclaw-demo-response-review"].wires, [
      ["redclaw-demo-review-ui"],
      ["redclaw-demo-orchestrator"],
      ["redclaw-demo-orchestrator"],
    ]);
  });

  it("uses Copilot for generation and applies exact, fail-closed ShieldGemma checks", () => {
    const flow = loadFlow();
    const byId = Object.fromEntries(flow.map(node => [node.id, node]));
    const inputFilter = byId["redclaw-demo-shield-input-evaluate"].func;
    const outputFilter = byId["redclaw-demo-shield-output-evaluate"].func;
    const shieldCatch = byId["redclaw-demo-shield-catch"];

    assert.equal(byId["redclaw-demo-orchestrator"].llmMode, "external");
    assert.equal(byId["redclaw-demo-orchestrator"].strictToolAllowlist, true);
    assert.equal(byId["redclaw-demo-orchestrator"].memoryEnabled, false);
    assert.equal(byId["redclaw-demo-copilot"].model, "Claude Haiku 4.5");
    assert.equal(byId["redclaw-demo-copilot"].timeout, 120000);
    assert.equal(byId["redclaw-demo-shield-input-http"].url, "http://localhost:11434/api/chat");
    assert.equal(byId["redclaw-demo-shield-output-http"].url, "http://localhost:11434/api/chat");
    assert.match(byId["redclaw-demo-shield-input-prepare"].func, /shieldgemma:2b/);
    assert.match(byId["redclaw-demo-shield-output-prepare"].func, /shieldgemma:2b/);
    assert.match(inputFilter, /normalized === "no"/);
    assert.match(inputFilter, /normalized === "yes"/);
    assert.match(outputFilter, /normalized === "no"/);
    assert.match(outputFilter, /normalized === "yes"/);
    assert.match(inputFilter, /Verdict ShieldGemma ambigu/);
    assert.match(outputFilter, /Verdict ShieldGemma ambigu/);
    assert.match(inputFilter, /statusCode !== 200/);
    assert.match(outputFilter, /statusCode !== 200/);
    assert.equal(byId["redclaw-demo-shield-error-response"].wires[0][0], "redclaw-demo-chat");
    assert.ok(shieldCatch.scope.includes("redclaw-demo-shield-input-http"));
    assert.ok(shieldCatch.scope.includes("redclaw-demo-shield-output-http"));
    assert.ok(byId["redclaw-demo-shield-input-evaluate"].wires[1].includes("redclaw-demo-chat"));
    assert.ok(byId["redclaw-demo-shield-output-evaluate"].wires[1].includes("redclaw-demo-chat"));
  });

  it("keeps tool dispatch read-only, explicitly authorized, and denied by default", () => {
    const flow = loadFlow();
    const byId = Object.fromEntries(flow.map(node => [node.id, node]));
    const policies = JSON.parse(byId["redclaw-demo-policy-config"].policies);
    const gateRules = JSON.parse(byId["redclaw-demo-security-gate"].rules);

    assert.equal(byId["redclaw-demo-skill"].tools, "");
    assert.match(byId["redclaw-demo-tool-test-request"].func, /get_local_time/);
    assert.deepEqual(byId["redclaw-demo-tool-test-request"].wires[0], ["redclaw-demo-policy"]);
    assert.deepEqual(byId["redclaw-demo-mcp-router"].tools, [{ name: "get_local_time" }]);
    assert.equal(byId["redclaw-demo-mcp-adapter"].toolName, "get_local_time");
    assert.equal(byId["redclaw-demo-mcp-adapter"].simpleMode, true);
    assert.match(byId["redclaw-demo-local-time"].func, /toLocaleString/);
    assert.equal(byId["redclaw-demo-security-gate"].defaultAction, "deny");
    assert.deepEqual(gateRules.map(rule => [rule.tool, rule.action]), [["get_local_time", "allow"]]);
    assert.equal(policies.length, 1);
    assert.equal(policies[0].active, true);
    assert.match(policies[0].condition, /get_local_time/);
    assert.equal(byId["redclaw-demo-approval"].requireAuthenticatedReviewer, true);
    assert.deepEqual(byId["redclaw-demo-mcp-router"].wires, [
      ["redclaw-demo-mcp-adapter"],
      ["redclaw-demo-trust"],
    ]);
    assert.deepEqual(byId["redclaw-demo-mcp-adapter"].wires, [
      ["redclaw-demo-local-time"],
      ["redclaw-demo-mcp-router"],
    ]);
    assert.deepEqual(byId["redclaw-demo-trust"].wires[0], ["redclaw-demo-tool-result"]);
  });

  it("wires embeddings and Tree Reasoner with a local evaluator and visible fallback", () => {
    const flow = loadFlow();
    const byId = Object.fromEntries(flow.map(node => [node.id, node]));
    const dashboardPage = flow.find(node => node.type === "ui-page");

    assert.equal(dashboardPage.path, "/assistant");
    assert.equal(dashboardPage.ui, "27f59ba7fc7bf071");
    assert.equal(dashboardPage.theme, "ab442d160216233c");
    assert.ok(flow.some(node => node.type === "ui-text-input"));
    assert.ok(flow.filter(node => node.type === "ui-template").length >= 5);
    assert.deepEqual(byId["redclaw-demo-goal-count"].wires[0], [
      "redclaw-demo-goal",
      "redclaw-demo-observe",
    ]);
    assert.deepEqual(byId["redclaw-demo-reflect"].wires[1], ["redclaw-demo-chat"]);
    assert.deepEqual(byId["redclaw-demo-diverge"].wires, [
      ["redclaw-demo-diverge-skill"],
      ["redclaw-demo-diverge-ui"],
    ]);
    assert.deepEqual(byId["redclaw-demo-diverge-skill"].wires[0], [
      "redclaw-demo-diverge-orchestrator",
    ]);
    assert.notEqual(byId["redclaw-demo-embed"].d, true);
    assert.equal(byId["redclaw-demo-embed"].mode, "both");
    assert.equal(byId["redclaw-demo-embed"].storeName, "assistant-diagnostic");
    assert.equal(byId["redclaw-demo-embed"].topK, 5);
    assert.equal(byId["redclaw-demo-embed"].threshold, 0.5);
    assert.equal(byId["redclaw-demo-embed-config"].backend, "ollama");
    assert.equal(byId["redclaw-demo-embed-config"].model, "mxbai-embed-large");
    assert.equal(byId["redclaw-demo-embed-config"].baseUrl, "http://localhost:11434");
    assert.equal(byId["redclaw-demo-orchestrator"].reasoningMode, "tree");
    assert.equal(
      byId["redclaw-demo-orchestrator"].evaluatorLlmConfig,
      "redclaw-demo-llm-config",
    );
    assert.equal(byId["redclaw-demo-orchestrator"].treeSafetyEnabled, false);
    assert.equal(byId["redclaw-demo-orchestrator"].llmMode, "external");
    assert.equal(byId["redclaw-demo-llm-config"].model, "gemma4:e2b");
    assert.match(byId["redclaw-demo-copilot"].systemMessage, /instructions et du contexte RedClaw/);
    const adaptCopilotPrompt = new Function(
      "msg",
      "node",
      byId["redclaw-demo-copilot-prompt-adapter"].func,
    );
    const bridgedMessage = {
      payload: [
        { role: "system", content: "skill et contexte sémantique" },
        { role: "user", content: "étape Tree Reasoner" },
      ],
      redclaw_llm_id: "correlation-1",
    };
    const adaptedMessage = adaptCopilotPrompt(bridgedMessage, { error() {} });
    assert.equal(adaptedMessage.payload.prompt.includes("skill et contexte sémantique"), true);
    assert.equal(adaptedMessage.payload.prompt.includes("étape Tree Reasoner"), true);
    assert.equal(adaptedMessage.redclaw_llm_id, "correlation-1");

    const adapterErrors = [];
    const invalidMessage = adaptCopilotPrompt(
      { payload: "unexpected" },
      { error(error) { adapterErrors.push(error); } },
    );
    assert.equal(invalidMessage, null);
    assert.equal(adapterErrors.length, 1);

    assert.equal(byId["redclaw-demo-embed-fallback"].outputs, 2);
    assert.match(byId["redclaw-demo-embed-fallback"].func, /msg\.embed_error/);
    assert.match(byId["redclaw-demo-embed-fallback"].func, /chat_kind: "proactive"/);
    assert.match(byId["redclaw-demo-embed-fallback"].func, /chat_category: "warning"/);

    const fallback = new Function("msg", byId["redclaw-demo-embed-fallback"].func);
    const noResults = { payload: "question", embed_context: "" };
    assert.deepEqual(fallback(noResults), [noResults, null]);

    const failed = { payload: "question", embed_error: "Ollama unavailable" };
    const [continued, warning] = fallback(failed);
    assert.equal(continued, failed);
    assert.equal(warning.chat_kind, "proactive");
    assert.equal(warning.chat_category, "warning");
    assert.match(warning.payload, /continue sans contexte mémorisé/);
  });
});
