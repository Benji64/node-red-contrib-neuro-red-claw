const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const helper = require("node-red-node-test-helper");
const mcpRouter = require("../../nodes/mcp-router.js");

helper.init(require.resolve("node-red"));

describe("mcp-router", () => {
  afterEach(() => helper.unload());

  it("route vers la sortie numérotée correspondant au nom du tool", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-router", timeout: 500, debugMode: false,
        tools: [{ name: "turn_on" }, { name: "turn_off" }],
        wires: [["outOn"], ["outOff"], ["outRetour"]] },
      { id: "outOn", type: "helper" }, { id: "outOff", type: "helper" }, { id: "outRetour", type: "helper" },
    ];
    helper.load(mcpRouter, flow, () => {
      const n1 = helper.getNode("n1");
      helper.getNode("outOff").on("input", () => done(new Error("ne doit pas router vers turn_off")));
      helper.getNode("outOn").on("input", (msg) => {
        try {
          assert.equal(msg.routeur.tool, "turn_on");
          assert.ok(msg.routeur.callId);
          done();
        } catch (e) { done(e); }
      });
      n1.receive({ redclaw: { tool: "turn_on", params: { device: "salon" } }, redclaw_call_id: "orig1" });
    });
  });

  it("résout et retourne le résultat sur la sortie ⚡ avec le callId original", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-router", timeout: 500, debugMode: false,
        tools: [{ name: "turn_on" }],
        wires: [["outOn"], ["outRetour"]] },
      { id: "outOn", type: "helper" }, { id: "outRetour", type: "helper" },
    ];
    helper.load(mcpRouter, flow, () => {
      const n1 = helper.getNode("n1");
      helper.getNode("outOn").on("input", (msg) => {
        // Simule un adapter qui répond
        n1.receive({ adaptateur: { callId: msg.routeur.callId, success: true, state: "ON" } });
      });
      helper.getNode("outRetour").on("input", (msg) => {
        try {
          assert.equal(msg.redclaw_call_id, "orig1", "doit renvoyer le callId ORIGINAL, pas l'interne");
          assert.equal(msg.payload.state, "ON");
          done();
        } catch (e) { done(e); }
      });
      n1.receive({ redclaw: { tool: "turn_on", params: {} }, redclaw_call_id: "orig1" });
    });
  });

  it("timeout : renvoie une erreur sur la sortie ⚡ si aucun adapter ne répond", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-router", timeout: 100, debugMode: false,
        tools: [{ name: "turn_on" }],
        wires: [["outOn"], ["outRetour"]] },
      { id: "outOn", type: "helper" }, { id: "outRetour", type: "helper" },
    ];
    helper.load(mcpRouter, flow, () => {
      const n1 = helper.getNode("n1");
      helper.getNode("outRetour").on("input", (msg) => {
        try {
          assert.ok(msg.redclaw_error, "doit produire une erreur explicite au timeout");
          done();
        } catch (e) { done(e); }
      });
      n1.receive({ redclaw: { tool: "turn_on", params: {} }, redclaw_call_id: "orig1" });
    });
  });

  it("tool inconnu (non câblé) : erreur explicite, pas de blocage silencieux", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-router", timeout: 500, debugMode: false,
        tools: [{ name: "turn_on" }],
        wires: [["outOn"], ["outRetour"]] },
      { id: "outOn", type: "helper" }, { id: "outRetour", type: "helper" },
    ];
    helper.load(mcpRouter, flow, () => {
      const n1 = helper.getNode("n1");
      helper.getNode("outRetour").on("input", (msg) => {
        try {
          assert.match(msg.payload, /inconnu/i);
          done();
        } catch (e) { done(e); }
      });
      n1.receive({ redclaw: { tool: "tool_jamais_cable", params: {} }, redclaw_call_id: "x" });
    });
  });
});
