const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const helper = require("node-red-node-test-helper");
const redclawObserve = require("../../nodes/redclaw-observe.js");
const neuroContext = require("../../nodes/neuro-context.js");
const redclawSkill = require("../../nodes/redclaw-skill.js");
const { loadContract, snapshot, validate } = require("../../lib/cognitive-contract");

helper.init(require.resolve("node-red"));

describe("integration : observation → contexte → skill", () => {
  afterEach(() => helper.unload());

  it("transmet une observation corrélée sur Output 2 sans déclencher un nouveau raisonnement", (t, done) => {
    const flow = [
      {
        id: "observe",
        type: "redclaw-observe",
        triggerMode: "manual",
        includeGoals: false,
        includeSkills: false,
        wires: [[], ["followup"]],
      },
      { id: "followup", type: "helper" },
    ];

    helper.load(redclawObserve, flow, () => {
      const observe = helper.getNode("observe");
      const contract = loadContract("redclaw-observe");
      const input = {
        payload: "private sensor value",
        redclaw_request_id: "completed-request-1",
        ora_source: "door-sensor",
        ora_key: "state",
        ora_unit: "state",
      };
      const before = snapshot(input);

      helper.getNode("followup").on("input", msg => {
        try {
          const result = validate(contract, before, msg);
          assert.equal(result.ok, true, result.violations.join("; "));
          assert.equal(msg.redclaw_request_id, "completed-request-1");
          assert.equal(msg.ora_observation_outcome.source, "door-sensor");
          assert.equal(msg.ora_observation_outcome.key, "state");
          assert.equal(msg.ora_observation_outcome.value, "private sensor value");
          assert.ok(msg.ora_observation_outcome.id);
          assert.equal(msg.ora_trigger, undefined);
          done();
        } catch (error) {
          done(error);
        }
      });

      observe.receive(input);
    });
  });

  it("préserve la corrélation et respecte chaque contrat du flow", (t, done) => {
    const flow = [
      {
        id: "observe",
        type: "redclaw-observe",
        skillName: "energy",
        triggerMode: "always",
        includeGoals: false,
        includeSkills: false,
        wires: [["observed"], []],
      },
      {
        id: "context",
        type: "neuro-context",
        includeState: true,
        includeTickets: false,
        includeGoals: false,
        includeConstraints: false,
        wires: [["contextResult"], ["error"]],
      },
      {
        id: "skill",
        type: "redclaw-skill",
        skillName: "energy",
        context: "Monitor energy usage",
        wires: [["result"]],
      },
      { id: "result", type: "helper" },
      { id: "observed", type: "helper" },
      { id: "contextResult", type: "helper" },
      { id: "error", type: "helper" },
    ];

    helper.load([redclawObserve, neuroContext, redclawSkill], flow, () => {
      const observe = helper.getNode("observe");
      const context = helper.getNode("context");
      const contracts = {
        observe: loadContract("redclaw-observe"),
        context: loadContract("neuro-context"),
        skill: loadContract("redclaw-skill"),
      };
      const input = {
        payload: 23,
        topic: "climate",
        correlationId: "flow-correlation-1",
        ora_source: "climate",
        ora_key: "temperature",
        ora_unit: "C",
      };
      const beforeObserve = snapshot(input);
      let beforeContext;
      let beforeSkill;

      helper.getNode("error").on("input", msg => done(new Error(msg.payload)));
      helper.getNode("result").on("input", msg => {
        try {
          const skillCheck = validate(contracts.skill, beforeSkill, msg);
          assert.equal(skillCheck.ok, true, skillCheck.violations.join("; "));
          assert.equal(msg.correlationId, "flow-correlation-1");
          assert.equal(msg.redclaw.skill.name, "energy");
          assert.match(msg.redclaw.userMessage, /temperature: 23C/);
          assert.deepEqual(msg.neuro.context.state, { climate_temperature: 23 });
          assert.deepEqual(msg.neuro.trace.map(entry => entry.node), ["context_engine", "skill:energy"]);
          done();
        } catch (error) {
          done(error);
        }
      });

      helper.getNode("contextResult").on("input", msg => {
        const result = validate(contracts.context, beforeContext, msg);
        if (!result.ok) {
          done(new Error(result.violations.join("; ")));
          return;
        }
        beforeSkill = snapshot(msg);
        helper.getNode("skill").receive(msg);
      });

      helper.getNode("observed").on("input", msg => {
        const result = validate(contracts.observe, beforeObserve, msg);
        if (!result.ok) {
          done(new Error(result.violations.join("; ")));
          return;
        }
        beforeContext = snapshot(msg);
        context.receive(msg);
      });

      observe.receive(input);
    });
  });
});
