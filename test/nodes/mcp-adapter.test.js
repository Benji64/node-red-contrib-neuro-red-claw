const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const helper = require("node-red-node-test-helper");
const mcpAdapter = require("../../nodes/mcp-adapter.js");

helper.init(require.resolve("node-red"));

describe("mcp-adapter", () => {
  afterEach(() => helper.unload());

  it("CAS 2→transform entrée→Output1, puis retour simulé→CAS1→Output2 avec callId propagé", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "turn_on", timeout: 500, debugMode: false,
        inputTransform: "msg.payload = { dps: 1, set: msg.payload.state === 'ON' }; return msg;",
        outputTransform: "adaptateur.success = true; adaptateur.state = msg.payload.dps === 1 ? 'ON' : 'OFF';",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const n1 = helper.getNode("n1");

      helper.getNode("outNode").on("input", (msg) => {
        try {
          // Vérifie ce que le "nœud cible" (ex: Tuya) recevrait réellement
          assert.deepEqual(msg.payload, { dps: 1, set: true });
          assert.equal(msg.redclaw_call_id, "cid1", "callId doit être propagé vers le nœud cible");
        } catch (e) { return done(e); }
        // Simule le nœud cible qui préserve msg et met à jour payload (bon comportement Node-RED)
        n1.receive({ ...msg, payload: { dps: 1, state: "confirmed" } });
      });

      helper.getNode("outRouter").on("input", (msg) => {
        try {
          assert.equal(msg.adaptateur.callId, "cid1", "le router doit pouvoir lire adaptateur.callId");
          assert.equal(msg.adaptateur.success, true);
          assert.equal(msg.adaptateur.state, "ON");
          done();
        } catch (e) { done(e); }
      });

      // Exactement ce que mcp-router envoie en sortie 1, vérifié dans son code source
      n1.receive({ routeur: { tool: "turn_on", params: { state: "ON" }, callId: "cid1" } });
    });
  });

  it("mode simple : passe msg.payload sans transformation", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "x", simpleMode: true, timeout: 500,
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      helper.getNode("outNode").on("input", (msg) => {
        assert.deepEqual(msg.payload, { device: "salon" });
        done();
      });
      helper.getNode("n1").receive({ routeur: { tool: "x", params: { device: "salon" }, callId: "c1" } });
    });
  });

  it("filtre de corrélation : ignore un message non pertinent, résout sur le suivant", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "turn_on", timeout: 1000,
        validateResponse: "return msg.payload?.dps?.['1'] !== undefined;",
        outputTransform: "adaptateur.success = true;",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const n1 = helper.getNode("n1");
      let outRouterCalls = 0;
      helper.getNode("outRouter").on("input", (msg) => {
        outRouterCalls++;
        try {
          assert.equal(outRouterCalls, 1, "seule la 2e réponse (valide) doit résoudre — la 1re ignorée ne doit rien produire");
          assert.equal(msg.adaptateur.success, true);
          done();
        } catch (e) { done(e); }
      });
      n1.receive({ routeur: { tool: "turn_on", params: {}, callId: "c1" } });
      // Update périodique non pertinent (ex: un autre capteur du même hub) — doit être ignoré
      n1.receive({ redclaw_call_id: "c1", payload: { dps: { "2": 42 } } });
      // La vraie réponse arrive ensuite — doit résoudre
      n1.receive({ redclaw_call_id: "c1", payload: { dps: { "1": true } } });
    });
  });
});
