/**
 * Test d'intégration : mcp-router + mcp-adapter câblés ensemble dans un
 * flow réel, avec un helper simulant un nœud cible type Tuya. C'est ce
 * test qui a révélé le vrai décalage entre le protocole documenté
 * (msg.adaptateur.callId comme source de vérité) et l'implémentation
 * réelle de mcp-router (qui lisait msg.redclaw_call_id) — corrigé en v2.8.
 */
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const helper = require("node-red-node-test-helper");
const mcpRouter  = require("../../nodes/mcp-router.js");
const mcpAdapter = require("../../nodes/mcp-adapter.js");

helper.init(require.resolve("node-red"));

describe("intégration mcp-router + mcp-adapter", () => {
  afterEach(() => helper.unload());

  it("orchestrateur → router → adapter → nœud cible → adapter → router → orchestrateur", (t, done) => {
    const flow = [
      { id: "router", type: "mcp-router", timeout: 1000, debugMode: false,
        tools: [{ name: "turn_on" }],
        wires: [["adapter"], ["retourOrch"]] },
      { id: "retourOrch", type: "helper" },

      { id: "adapter", type: "mcp-adapter", toolName: "turn_on", timeout: 800,
        inputTransform: "msg.payload = { dps: { '1': msg.payload.state === 'ON' } }; return msg;",
        outputTransform: "adaptateur.success = true; adaptateur.state = msg.payload.dps['1'] ? 'ON' : 'OFF';",
        wires: [["cibleTuya"], ["router"]] }, // Output2 revient bien sur l'entrée du router

      // Simule le nœud Tuya : préserve msg (bon comportement), renvoie tel quel
      { id: "cibleTuya", type: "helper" },
    ];

    helper.load([mcpRouter, mcpAdapter], flow, () => {
      const router = helper.getNode("router");
      const cible  = helper.getNode("cibleTuya");

      cible.on("input", (msg) => {
        // Un vrai nœud Tuya : modifie payload, préserve tout le reste
        helper.getNode("adapter").receive({ ...msg, payload: { dps: { "1": true } } });
      });

      helper.getNode("retourOrch").on("input", (msg) => {
        try {
          assert.equal(msg.redclaw_call_id, "orig-orchestrateur-id", "le callId ORIGINAL de l'orchestrateur doit revenir intact");
          assert.equal(msg.payload.success, true);
          assert.equal(msg.payload.state, "ON");
          assert.equal(msg.payload.callId, undefined, "le callId interne ne doit jamais fuiter vers l'orchestrateur");
          done();
        } catch (e) { done(e); }
      });

      router.receive({
        redclaw: { tool: "turn_on", params: { state: "ON" } },
        redclaw_call_id: "orig-orchestrateur-id",
      });
    });
  });
});
