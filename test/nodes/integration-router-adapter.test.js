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
const actionAuthority = require("../../lib/action-authority");

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

      const request = {
        redclaw: { tool: "turn_on", params: { state: "ON" } },
        redclaw_call_id: "orig-orchestrateur-id",
      };
      request.redclaw_authorization = actionAuthority.issuePermit({
        tool: request.redclaw.tool,
        params: request.redclaw.params,
        sessionId: "default",
      });
      router.receive(request);
    });
  });

  it("un dispatch rejeté ou dupliqué ne peut pas terminer l'appel autorisé en vol", (t, done) => {
    const flow = [
      { id: "router", type: "mcp-router", timeout: 1000, debugMode: false,
        tools: [{ name: "read" }],
        wires: [["adapter"], ["retourOrch"]] },
      { id: "retourOrch", type: "helper" },
      { id: "adapter", type: "mcp-adapter", toolName: "read", timeout: 800,
        outputTransform: "adaptateur.success = true; adaptateur.result = msg.payload.result;",
        wires: [["cible"], ["router"]] },
      { id: "cible", type: "helper" },
    ];

    helper.load([mcpRouter, mcpAdapter], flow, () => {
      const router = helper.getNode("router");
      const adapter = helper.getNode("adapter");
      helper.getNode("cible").on("input", msg => {
        const deniedRoute = {
          tool: "read",
          params: {},
          callId: msg.redclaw_call_id,
        };
        const deniedToken = actionAuthority.issuePermit({
          tool: deniedRoute.tool,
          params: deniedRoute.params,
          sessionId: "different-session",
          kind: "dispatch",
          correlationId: deniedRoute.callId,
        });
        adapter.receive({
          ...msg,
          routeur: deniedRoute,
          redclaw_dispatch_authorization: deniedToken,
        });
        const duplicateToken = actionAuthority.issuePermit({
          tool: deniedRoute.tool,
          params: deniedRoute.params,
          sessionId: "default",
          kind: "dispatch",
          correlationId: deniedRoute.callId,
        });
        adapter.receive({
          ...msg,
          routeur: deniedRoute,
          redclaw_dispatch_authorization: duplicateToken,
        });
        adapter.receive({
          ...msg,
          payload: { result: "authorized response" },
        });
      });
      helper.getNode("retourOrch").on("input", msg => {
        try {
          assert.equal(msg.payload.success, true);
          assert.equal(msg.payload.result, "authorized response");
          done();
        } catch (error) {
          done(error);
        }
      });
      const request = {
        redclaw: { tool: "read", params: {} },
        redclaw_call_id: "authorization-response-boundary",
      };
      request.redclaw_authorization = actionAuthority.issuePermit({
        tool: "read",
        params: {},
        sessionId: "default",
      });
      router.receive(request);
    });
  });
});
