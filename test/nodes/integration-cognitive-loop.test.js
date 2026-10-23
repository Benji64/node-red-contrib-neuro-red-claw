"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const helper = require("node-red-node-test-helper");
const redclawObserve = require("../../nodes/redclaw-observe");
const redclawSkill = require("../../nodes/redclaw-skill");
const orchestrator = require("../../nodes/agent-orchestrator");
const redclawPolicy = require("../../nodes/redclaw-policy");
const securityGate = require("../../nodes/security-gate");
const mcpRouter = require("../../nodes/mcp-router");
const mcpAdapter = require("../../nodes/mcp-adapter");
const redclawReflect = require("../../nodes/redclaw-reflect");
const observationStore = require("../../lib/observation-store");
const ticketStore = require("../../lib/ticket-store");
const { analyzeFlow } = require("../../lib/cognitive-graph-analyzer");

helper.init(require.resolve("node-red"));

describe("integrated observation-reason-action-learning flow", () => {
  let memoryDir;
  let ticketCache;
  let originalSettings;

  afterEach(async () => {
    await helper.unload();
    if (originalSettings) {
      helper.settings(originalSettings);
      originalSettings = null;
    }
    observationStore.clear();
    if (ticketCache) {
      ticketStore._cache = ticketCache;
      ticketCache = null;
    }
    if (memoryDir) {
      fs.rmSync(memoryDir, { recursive: true, force: true });
      memoryDir = null;
    }
  });

  it("runs a protected tool action, links its later observation, and creates an inactive learning candidate",
    (t, done) => {
      memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "redclaw-cognitive-loop-"));
      ticketCache = ticketStore._cache;
      ticketStore._cache = [];
      const skillName = `loop-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const skillDocument = `---
name: ${skillName}
description: Integration test skill for provenance tracing.
---

Use the test lamp and report its observed state.
`;
      fs.mkdirSync(path.join(memoryDir, "skills", skillName), { recursive: true });
      fs.writeFileSync(
        path.join(memoryDir, "skills", skillName, "SKILL.md"),
        skillDocument,
        "utf8"
      );
      const skillSha256 = crypto.createHash("sha256").update(skillDocument, "utf8").digest("hex");
      originalSettings = helper.settings();
      helper.settings({ ...originalSettings, userDir: memoryDir });
      const flow = [
        {
          id: "observe",
          type: "redclaw-observe",
          skillName,
          triggerMode: "manual",
          includeGoals: false,
          includeSkills: false,
          wires: [["skill"], ["orchestrator"]],
        },
        {
          id: "skill",
          type: "redclaw-skill",
          agentSkillDir: skillName,
          skillName,
          context: "Operate the test lamp and report its observed state.",
          tools: "turn_on",
          wires: [["orchestrator"]],
        },
        {
          id: "orchestrator",
          type: "redclaw-orchestrator",
          llmMode: "external",
          memoryEnabled: false,
          memoryDir,
          runStorageDir: path.join(memoryDir, "runs"),
          wires: [["policy"], ["response"], ["llm"], []],
        },
        {
          id: "policy",
          type: "redclaw-policy",
          agentRole: "default",
          policies: "[]",
          logDecisions: false,
          wires: [["security"], [], ["blocked"]],
        },
        {
          id: "security",
          type: "security-gate",
          logBlocked: false,
          rules: JSON.stringify([{
            tool: "turn_on",
            action: "allow",
            riskCategories: ["technical"],
            impact: "low",
          }]),
          wires: [["router"], ["blocked"], ["blocked"]],
        },
        {
          id: "router",
          type: "mcp-router",
          timeout: 1000,
          tools: [{ name: "turn_on" }],
          wires: [["adapter"], ["orchestrator"]],
        },
        {
          id: "adapter",
          type: "mcp-adapter",
          toolName: "turn_on",
          timeout: 1000,
          inputTransform: "msg.payload = { state: msg.payload.state }; return msg;",
          outputTransform: "adaptateur.success = true; adaptateur.state = msg.payload.state;",
          wires: [["device"], ["router"]],
        },
        {
          id: "device",
          type: "helper",
        },
        {
          id: "response",
          type: "helper",
        },
        {
          id: "llm",
          type: "helper",
        },
        {
          id: "blocked",
          type: "helper",
        },
        {
          id: "reflect",
          type: "redclaw-reflect",
          skillName,
          useLlm: false,
          learningStoreDir: path.join(memoryDir, "learning"),
          wires: [["reflection"], ["adjustments"]],
        },
        {
          id: "reflection",
          type: "helper",
        },
        {
          id: "adjustments",
          type: "helper",
        },
      ];

      const graph = analyzeFlow(flow);
      assert.equal(graph.ok, true, graph.violations.map(issue => issue.message).join("\n"));

      helper.load([
        redclawObserve,
        redclawSkill,
        orchestrator,
        redclawPolicy,
        securityGate,
        mcpRouter,
        mcpAdapter,
        redclawReflect,
      ], flow, () => {
        const orch = helper.getNode("orchestrator");
        let llmCallCount = 0;
        let requestId;
        let responseReceived = false;
        let reflectionReceived = false;
        let adjustmentsReceived = false;
        let followupReceived = false;

        function finishIfComplete() {
          if (responseReceived && reflectionReceived &&
              adjustmentsReceived && followupReceived) {
            done();
          }
        }

        helper.getNode("blocked").on("input", msg =>
          done(new Error(`Protected action unexpectedly blocked: ${msg.payload}`))
        );
        helper.getNode("device").on("input", msg => {
          try {
            assert.ok(msg.redclaw_call_id);
            assert.deepEqual(msg.payload, { state: "ON" });
            helper.getNode("adapter").receive({
              ...msg,
              payload: { state: "ON" },
            });
          } catch (error) {
            done(error);
          }
        });
        helper.getNode("llm").on("input", prompt => {
          try {
            assert.match(prompt.payload[0].content, /Use the test lamp and report its observed state\./);
            const answer = llmCallCount++ === 0
              ? { action: "tool", tool: "turn_on", params: { state: "ON" } }
              : { action: "respond", message: "Lamp command completed" };
            orch.receive({ ...prompt, payload: JSON.stringify(answer) });
          } catch (error) {
            done(error);
          }
        });
        helper.getNode("response").on("input", msg => {
          try {
            if (msg.redclaw_observation_link) {
              assert.equal(msg.redclaw_observation_link.linked, true);
              assert.equal(msg.redclaw_observation_link.request_id, requestId);
              assert.ok(msg.redclaw_observation_link.observation_id);
              const actual = msg.ora_observation_outcome.value;
              assert.deepEqual(actual, { state: "OFF" });
              followupReceived = true;
              helper.getNode("reflect").receive({
                ...msg,
                redclaw_run_id: msg.redclaw_observation_link.run_id,
                redclaw_prediction: { state: "ON" },
                redclaw_outcome: actual,
              });
              finishIfComplete();
              return;
            }

            assert.equal(msg.payload, "Lamp command completed");
            assert.equal(typeof msg.redclaw_request_id, "string");
            requestId = msg.redclaw_request_id;
            const run = orch.instrumentation.recentRuns()
              .find(candidate => candidate.request_id === requestId);
            assert.ok(run);
            assert.equal(run.status, "completed");
            assert.equal(run.skill_name, skillName);
            assert.equal(run.skill_sha256, skillSha256);
            assert.equal(run.events[0].skill_name, skillName);
            assert.equal(run.events[0].skill_sha256, skillSha256);
            assert.equal(run.outcome.tool_outcomes[0].tool, "turn_on");
            assert.equal(run.outcome.tool_outcomes[0].reported_success, true);
            const persistedRun = JSON.parse(
              fs.readFileSync(path.join(memoryDir, "runs", "cognitive-runs.jsonl"), "utf8").trim()
            );
            assert.equal(persistedRun.skill_name, skillName);
            assert.equal(persistedRun.skill_sha256, skillSha256);
            responseReceived = true;

            helper.getNode("observe").receive({
              payload: { state: "OFF" },
              redclaw_request_id: requestId,
              ora_source: "test-lamp",
              ora_key: "state",
              ora_unit: "state",
            });
            finishIfComplete();
          } catch (error) {
            done(error);
          }
        });
        helper.getNode("reflection").on("input", msg => {
          try {
            const comparison = msg.redclaw_reflect.predictionOutcome;
            assert.equal(comparison.runId, msg.redclaw_run_id);
            assert.equal(comparison.matches, false);
            assert.ok(msg.redclaw_learning_candidates.some(candidate =>
              candidate.type === "memory_candidate" &&
              candidate.state === "pending_review" &&
              candidate.active === false
            ));
            reflectionReceived = true;
            finishIfComplete();
          } catch (error) {
            done(error);
          }
        });
        helper.getNode("adjustments").on("input", msg => {
          try {
            assert.ok(msg.redclaw_learning_candidates.length > 0);
            assert.ok(msg.redclaw_learning_candidates.every(candidate =>
              candidate.state === "pending_review" &&
              candidate.active === false &&
              candidate.requiresHumanApproval === true
            ));
            adjustmentsReceived = true;
            finishIfComplete();
          } catch (error) {
            done(error);
          }
        });

        helper.getNode("observe").receive({
          payload: "Turn on the test lamp.",
          ora_source: "operator",
          ora_key: "request",
          ora_unit: "text",
          ora_trigger: true,
          redclaw_prediction: { state: "ON" },
        });
      });
    });
});
