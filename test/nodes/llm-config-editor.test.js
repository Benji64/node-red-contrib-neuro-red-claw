const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createEditor(fetch, backend = "ollama") {
  const html = fs.readFileSync(
    path.join(__dirname, "../../nodes/llm-config.html"),
    "utf8"
  );
  const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/);
  assert.ok(script, "the LLM config editor script should be present");

  const handlers = new Map();
  const values = new Map([
    ["#node-config-input-llmType", backend],
    ["#node-config-input-baseUrl", "http://localhost:11434"],
    ["#node-config-input-model", ""],
    ["#node-config-input-apiKey", ""],
  ]);
  const state = { text: "", color: "", disabled: false };
  const button = {
    text(value) {
      state.text = value;
      return this;
    },
    prop(name, value) {
      if (name === "disabled") state.disabled = value;
      return this;
    },
    css(name, value) {
      if (name === "color") state.color = value;
      return this;
    },
  };
  const controls = new Map();
  const $ = selector => {
    if (selector === button) return button;
    if (!controls.has(selector)) {
      controls.set(selector, {
        val(value) {
          if (arguments.length) values.set(selector, value);
          return values.get(selector);
        },
        attr() { return this; },
        toggle() { return this; },
        on(event, handler) {
          handlers.set(`${selector}:${event}`, handler);
          return this;
        },
      });
    }
    return controls.get(selector);
  };
  const RED = { nodes: { registerType(type, definition) {
    assert.equal(type, "llm-config");
    this.definition = definition;
  } } };

  vm.runInNewContext(script[1], { RED, $, fetch, setTimeout() {} });
  RED.nodes.definition.oneditprepare();
  return {
    state,
    click: () => handlers.get("#rc-llm-test:click").call(button),
  };
}

describe("llm-config editor connection test", () => {
  it("does not report a failed Ollama HTTP response as connected", async () => {
    const editor = createEditor(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ models: [] }),
    }));

    await editor.click();

    assert.equal(editor.state.text, "✗ HTTP 503");
    assert.equal(editor.state.color, "red");
    assert.equal(editor.state.disabled, false);
  });

  it("rejects a malformed Ollama models response", async () => {
    const editor = createEditor(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: "not-an-array" }),
    }));

    await editor.click();

    assert.equal(editor.state.text, "✗ Réponse Ollama invalide");
    assert.equal(editor.state.color, "red");
  });

  it("reports the number of models for a valid Ollama response", async () => {
    const editor = createEditor(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: "model-a" }, { name: "model-b" }] }),
    }));

    await editor.click();

    assert.equal(editor.state.text, "✓ 2 modèle(s)");
    assert.equal(editor.state.color, "green");
  });

  it("does not report an OpenAI-compatible HTTP failure as connected", async () => {
    const editor = createEditor(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ data: [] }),
    }), "openai");

    await editor.click();

    assert.equal(editor.state.text, "✗ HTTP 401");
    assert.equal(editor.state.color, "red");
  });

  it("rejects malformed OpenAI-compatible model responses", async () => {
    const editor = createEditor(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: {} }),
    }), "lmstudio");

    await editor.click();

    assert.equal(editor.state.text, "✗ Réponse de modèles invalide");
    assert.equal(editor.state.color, "red");
  });

  it("reports a successful OpenAI-compatible model-list response", async () => {
    const editor = createEditor(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "embed-model" }] }),
    }), "mistral");

    await editor.click();

    assert.equal(editor.state.text, "✓ Connecté");
    assert.equal(editor.state.color, "green");
  });
});
