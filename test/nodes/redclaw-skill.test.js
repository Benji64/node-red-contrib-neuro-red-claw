const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const helper = require("node-red-node-test-helper");
const redclawSkill = require("../../nodes/redclaw-skill.js");

helper.init(require.resolve("node-red"));

describe("redclaw-skill", () => {
  afterEach(() => helper.unload());

  it("enrichit msg.redclaw et fixe sessionId = nom du skill", (t, done) => {
    const flow = [
      { id: "n1", type: "redclaw-skill", name: "test",
        skillName: "energie", context: "ctx", tools: "turn_on,turn_off",
        wires: [["n2"]] },
      { id: "n2", type: "helper" },
    ];
    helper.load(redclawSkill, flow, () => {
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.equal(msg.redclaw.userMessage, "allume le salon");
          assert.equal(msg.redclaw.skill.name, "energie");
          assert.equal(msg.sessionId, "energie");
          done();
        } catch (e) { done(e); }
      });
      n1.receive({ payload: "allume le salon" });
    });
  });

  it("ne tamponne PAS de trace si msg.neuro n'existe pas (passif, jamais forcé)", (t, done) => {
    const flow = [
      { id: "n1", type: "redclaw-skill", name: "test", skillName: "s", wires: [["n2"]] },
      { id: "n2", type: "helper" },
    ];
    helper.load(redclawSkill, flow, () => {
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.equal(msg.neuro, undefined, "msg.neuro ne doit jamais être créé d'office");
          done();
        } catch (e) { done(e); }
      });
      n1.receive({ payload: "x" });
    });
  });

  it("tamponne la trace SEULEMENT si msg.neuro existe déjà (opt-in respecté)", (t, done) => {
    const flow = [
      { id: "n1", type: "redclaw-skill", name: "test", skillName: "energie", wires: [["n2"]] },
      { id: "n2", type: "helper" },
    ];
    helper.load(redclawSkill, flow, () => {
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.match(msg.neuro.trace[msg.neuro.trace.length - 1].node, /skill:energie/);
          done();
        } catch (e) { done(e); }
      });
      n1.receive({ payload: "x", neuro: { id: "m1", trace: [] } });
    });
  });
});
