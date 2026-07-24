/**
 * Preuve la plus forte du fix v2.5 : deux nœuds redclaw-policy déployés
 * dans le MÊME flow Node-RED réel, avec le même scope "all", ne
 * s'influencent jamais — testé au niveau runtime où le bug du singleton
 * se manifestait vraiment (pas juste sur la fonction evaluate() isolée).
 */
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const helper = require("node-red-node-test-helper");
const RED = require("node-red");
const redclawPolicy = require("../../nodes/redclaw-policy.js");

helper.init(require.resolve("node-red"));

describe("redclaw-policy", () => {
  let logHandler = null;
  afterEach(() => {
    if (logHandler) { RED.log.removeHandler(logHandler); logHandler = null; }
    return helper.unload();
  });

  it("deux nœuds, même scope 'all', déployés ensemble : zéro influence croisée", (t, done) => {
    const flow = [
      // Nœud A : bloque tout agent 'guest', scope "all"
      { id: "polA", type: "redclaw-policy", name: "A", agentRole: "guest",
        policies: JSON.stringify([
          { name: "Bloquer invités", condition: "agent.role==='guest'", level: 0, priority: 90, scope: "all", active: true },
        ]),
        logDecisions: false, wires: [["allowedA"], ["restrictedA"], ["blockedA"]] },
      { id: "allowedA", type: "helper" }, { id: "restrictedA", type: "helper" }, { id: "blockedA", type: "helper" },

      // Nœud B : promeut TOUT, scope "all", même agentRole "guest" — aucun fil vers A
      { id: "polB", type: "redclaw-policy", name: "B", agentRole: "guest",
        policies: JSON.stringify([
          { name: "Toujours promouvoir", condition: "true", level: 4, priority: 99, scope: "all", active: true },
        ]),
        logDecisions: false, wires: [["allowedB"], ["restrictedB"], ["blockedB"]] },
      { id: "allowedB", type: "helper" }, { id: "restrictedB", type: "helper" }, { id: "blockedB", type: "helper" },
    ];

    helper.load(redclawPolicy, flow, () => {
      const polA = helper.getNode("polA");
      const polB = helper.getNode("polB");
      const blockedA  = helper.getNode("blockedA");
      const allowedB  = helper.getNode("allowedB");

      let aBlocked = false, bPromoted = false;
      function finishIfDone() {
        if (aBlocked && bPromoted) done();
      }

      blockedA.on("input", () => { aBlocked = true; finishIfDone(); });
      allowedB.on("input", (msg) => {
        try {
          assert.equal(msg.redclaw_policy.level, 4, "B doit promouvoir, pas être bloqué par la règle guest de A");
          bPromoted = true;
          finishIfDone();
        } catch (e) { done(e); }
      });

      const msg = { redclaw: { tool: "turn_on" }, sessionId: "x" };
      polA.receive({ ...msg });
      polB.receive({ ...msg });
    });
  });

  it("route vers Output 1 (ALLOWED) quand aucune politique ne matche", (t, done) => {
    const flow = [
      { id: "n1", type: "redclaw-policy", policies: "[]", logDecisions: false,
        wires: [["out1"], ["out2"], ["out3"]] },
      { id: "out1", type: "helper" }, { id: "out2", type: "helper" }, { id: "out3", type: "helper" },
    ];
    helper.load(redclawPolicy, flow, () => {
      const n1 = helper.getNode("n1");
      helper.getNode("out2").on("input", () => done(new Error("ne doit pas router vers Output 2")));
      helper.getNode("out3").on("input", () => done(new Error("ne doit pas router vers Output 3")));
      helper.getNode("out1").on("input", (msg) => {
        assert.equal(msg.redclaw_policy.level, 3);
        done();
      });
      n1.receive({ redclaw: { tool: "x" } });
    });
  });

  it("route vers Output 3 (BLOCKED) quand la politique locale bloque", (t, done) => {
    const flow = [
      { id: "n1", type: "redclaw-policy", logDecisions: false,
        policies: JSON.stringify([{ name: "x", condition: "true", level: 0, priority: 50, scope: "all", active: true }]),
        wires: [["out1"], ["out2"], ["out3"]] },
      { id: "out1", type: "helper" }, { id: "out2", type: "helper" }, { id: "out3", type: "helper" },
    ];
    helper.load(redclawPolicy, flow, () => {
      const n1 = helper.getNode("n1");
      helper.getNode("out3").on("input", (msg) => {
        assert.equal(msg.redclaw_policy.level, 0);
        done();
      });
      n1.receive({ redclaw: { tool: "x" } });
    });
  });

  it("avertit au démarrage si RESTRICTED configuré mais Output 2 non câblé", (t, done) => {
    let warned = false;
    logHandler = new EventEmitter();
    logHandler.on("log", (msg) => {
      if (msg.msg && /Output 2/.test(msg.msg)) warned = true;
    });
    RED.log.addHandler(logHandler);

    const flow = [
      { id: "n1", type: "redclaw-policy", logDecisions: false,
        policies: JSON.stringify([{ name: "x", condition: "true", level: 1, priority: 50, scope: "all", active: true }]),
        wires: [["out1"], [], ["out3"]] }, // Output 2 volontairement non câblé
      { id: "out1", type: "helper" }, { id: "out3", type: "helper" },
    ];
    helper.load(redclawPolicy, flow, () => {
      setTimeout(() => {
        try {
          assert.equal(warned, true, "doit avertir qu'Output 2 n'a aucun consommateur");
          done();
        } catch (e) { done(e); }
      }, 50);
    });
  });

  it("n'avertit PAS si aucune politique RESTRICTED/SUPERVISED n'est configurée", (t, done) => {
    let warned = false;
    logHandler = new EventEmitter();
    logHandler.on("log", (msg) => {
      if (msg.msg && /Output 2/.test(msg.msg)) warned = true;
    });
    RED.log.addHandler(logHandler);

    const flow = [
      { id: "n1", type: "redclaw-policy", logDecisions: false,
        policies: JSON.stringify([{ name: "x", condition: "true", level: 0, priority: 50, scope: "all", active: true }]),
        wires: [["out1"], [], ["out3"]] },
      { id: "out1", type: "helper" }, { id: "out3", type: "helper" },
    ];
    helper.load(redclawPolicy, flow, () => {
      setTimeout(() => {
        try {
          assert.equal(warned, false, "pas de politique RESTRICTED/SUPERVISED → pas d'avertissement nécessaire");
          done();
        } catch (e) { done(e); }
      }, 50);
    });
  });

  it("n'avertit PAS si Output 2 est bien câblé", (t, done) => {
    let warned = false;
    logHandler = new EventEmitter();
    logHandler.on("log", (msg) => {
      if (msg.msg && /Output 2/.test(msg.msg)) warned = true;
    });
    RED.log.addHandler(logHandler);

    const flow = [
      { id: "n1", type: "redclaw-policy", logDecisions: false,
        policies: JSON.stringify([{ name: "x", condition: "true", level: 1, priority: 50, scope: "all", active: true }]),
        wires: [["out1"], ["out2"], ["out3"]] },
      { id: "out1", type: "helper" }, { id: "out2", type: "helper" }, { id: "out3", type: "helper" },
    ];
    helper.load(redclawPolicy, flow, () => {
      setTimeout(() => {
        try {
          assert.equal(warned, false, "Output 2 câblé → pas d'avertissement");
          done();
        } catch (e) { done(e); }
      }, 50);
    });
  });
});
