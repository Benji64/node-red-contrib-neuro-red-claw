const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createEditor(fetch) {
  const html = fs.readFileSync(
    path.join(__dirname, "../../nodes/agent-orchestrator.html"),
    "utf8"
  );
  const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/);
  assert.ok(script, "the orchestrator editor script should be present");

  const handlers = new Map();
  const controls = new Map();
  const $ = selector => {
    if (!controls.has(selector)) {
      let value = selector === "#node-input-llmMode"
        ? "internal"
        : selector === "#node-input-reasoningMode" ? "legacy" : "";
      controls.set(selector, {
        val(nextValue) {
          if (arguments.length) {
            value = nextValue;
            return this;
          }
          return value;
        },
        is() { return false; },
        toggle() { return this; },
        on(event, handler) {
          handlers.set(`${selector}:${event}`, handler);
          return this;
        },
      });
    }
    return controls.get(selector);
  };
  const notifications = [];
  const alerts = [];
  const RED = {
    nodes: { registerType(type, definition) {
      assert.equal(type, "redclaw-orchestrator");
      this.definition = definition;
    } },
    notify: (...args) => notifications.push(args),
  };

  vm.runInNewContext(script[1], {
    RED,
    $,
    fetch,
    alert: message => alerts.push(message),
  });
  RED.nodes.definition.oneditprepare();
  return { alerts, handlers, notifications, controls, definition: RED.nodes.definition };
}

describe("redclaw-orchestrator editor admin actions", () => {
  it("reports HTTP failures instead of treating them as empty admin data", async () => {
    const requested = [];
    const editor = createEditor(async url => {
      requested.push(url);
      return {
        ok: false,
        status: 403,
        json: async () => ({ error: "Accès refusé" }),
      };
    });

    for (const selector of [
      "#rc-btn-stats",
      "#rc-btn-tickets",
      "#rc-btn-tickets-fail",
      "#rc-btn-runs",
      "#rc-orch-sessions",
    ]) {
      await editor.handlers.get(`${selector}:click`)();
    }

    assert.deepEqual(requested, [
      "/redclaw/stats",
      "/redclaw/tickets?n=10",
      "/redclaw/tickets?n=20&status=failed",
      "/redclaw/runs?n=10",
      "/redclaw/sessions",
    ]);
    assert.deepEqual(editor.notifications, [
      ["Erreur: Accès refusé", "error"],
      ["Erreur: Accès refusé", "error"],
      ["Erreur: Accès refusé", "error"],
      ["Erreur: Accès refusé", "error"],
      ["Accès refusé", "error"],
    ]);
    assert.deepEqual(editor.alerts, []);
  });

  it("rejects malformed stats, ticket, run, and session payloads", async () => {
    const payloads = new Map([
      ["/redclaw/stats", { tickets: [], instrumentation: {} }],
      ["/redclaw/tickets?n=10", {
        tickets: [{ tool_calls: [null], steps: [], error: "" }],
      }],
      ["/redclaw/runs?n=10", { runs: [{ events: null, metrics: {} }] }],
      ["/redclaw/sessions", { sessions: {} }],
    ]);
    const editor = createEditor(async url => ({
      ok: true,
      json: async () => payloads.get(url),
    }));

    for (const selector of [
      "#rc-btn-stats",
      "#rc-btn-tickets",
      "#rc-btn-runs",
      "#rc-orch-sessions",
    ]) {
      await editor.handlers.get(`${selector}:click`)();
    }

    assert.deepEqual(editor.notifications, [
      ["Erreur: Réponse des statistiques invalide", "error"],
      ["Erreur: Réponse des tickets invalide", "error"],
      ["Erreur: Réponse des traces cognitives invalide", "error"],
      ["Réponse des sessions invalide", "error"],
    ]);
    assert.deepEqual(editor.alerts, []);
  });

  it("keeps the successful stats and ticket views", async () => {
    const editor = createEditor(async url => ({
      ok: true,
      json: async () => url === "/redclaw/stats"
        ? { tickets: { total: 0 }, instrumentation: {} }
        : { tickets: [{ id: "ticket-1", skill: "energy", steps: [], tool_calls: [] }] },
    }));

    await editor.handlers.get("#rc-btn-stats:click")();
    await editor.handlers.get("#rc-btn-tickets:click")();

    assert.equal(editor.alerts.length, 2);
    assert.match(editor.alerts[0], /Tickets/);
    assert.match(editor.alerts[1], /ticket-1/);
    assert.deepEqual(editor.notifications, []);
  });

  it("selects llm-config Tree generators directly and adds a dedicated output for each", () => {
    const editor = createEditor(async () => ({ ok: true, json: async () => ({}) }));
    const definition = editor.definition;
    const directGenerators = [
      { id: "tree-1", llmConfig: "ollama-gemma" },
      { id: "tree-2", llmConfig: "openai-gpt" },
    ];

    assert.equal(definition.outputs, 8);
    assert.equal(definition.outputLabels.call({ treeGenerators: directGenerators }, 2), "→ LLM externe (mode externe)");
    assert.equal(definition.outputLabels.call({ treeGenerators: directGenerators }, 4), "→ Générateur Tree : LLM 1");
    assert.equal(definition.outputLabels.call({ treeGenerators: directGenerators }, 5), "→ Générateur Tree : LLM 2");
    assert.equal(definition.outputLabels.call({ treeGenerators: [] }, 7), "→ Générateur Tree : LLM 4");
    assert.equal(definition.outputLabels.call({ treeGenerators: [] }, 8), undefined);

    editor.controls.get("#node-input-treeGeneratorConfig1").val("ollama-gemma");
    editor.controls.get("#node-input-treeGeneratorConfig2").val("openai-gpt");
    assert.equal(definition.oneditvalidate(), true);
    const node = {};
    definition.oneditsave.call(node);
    assert.equal(JSON.stringify(node.treeGenerators), JSON.stringify(directGenerators));
    assert.equal(node.outputs, 8);

    editor.controls.get("#node-input-treeGeneratorConfig1").val("");
    editor.controls.get("#node-input-treeGeneratorConfig2").val("openai-gpt");
    assert.equal(definition.oneditvalidate(), false);

    editor.controls.get("#node-input-treeGeneratorConfig1").val("openai-gpt");
    assert.equal(definition.oneditvalidate(), false);

    editor.controls.get("#node-input-treeGeneratorConfig1").val("");
    editor.controls.get("#node-input-treeGeneratorConfig2").val("");
    editor.controls.get("#node-input-treeGeneratorExternal1").val("Copilot");
    assert.equal(definition.oneditvalidate(), false);

    editor.controls.get("#node-input-llmMode").val("external");
    assert.equal(definition.oneditvalidate(), true);
    const externalNode = {};
    definition.oneditsave.call(externalNode);
    assert.equal(JSON.stringify(externalNode.treeGenerators), JSON.stringify([
      { id: "tree-1", label: "Copilot" },
    ]));
    assert.equal(externalNode.outputs, 8);
    assert.equal(
      definition.outputLabels.call({ treeGenerators: externalNode.treeGenerators }, 4),
      "→ Générateur Tree : Copilot"
    );

    editor.controls.get("#node-input-treeGeneratorExternal2").val("copilot");
    assert.equal(definition.oneditvalidate(), false);
    editor.controls.get("#node-input-treeGeneratorExternal2").val("");
    editor.controls.get("#node-input-treeGeneratorConfig1").val("ollama-gemma");
    editor.controls.get("#node-input-treeGeneratorExternal1").val("Copilot");
    assert.equal(definition.oneditvalidate(), false);
  });
});
