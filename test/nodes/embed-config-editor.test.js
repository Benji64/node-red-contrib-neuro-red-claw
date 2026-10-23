const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createEditor(response) {
  const html = fs.readFileSync(
    path.join(__dirname, "../../nodes/embed-config.html"),
    "utf8"
  );
  const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/);
  assert.ok(script, "the embedding config editor script should be present");

  const handlers = new Map();
  const values = new Map([
    ["#node-config-input-backend", "openai"],
    ["#node-config-input-baseUrl", "https://api.example.test"],
    ["#node-config-input-model", "embed-model"],
    ["#node-config-input-timeout", 15000],
    ["#node-config-input-restPath", "/embed"],
    ["#node-config-input-apiKey", "test-key"],
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
          if (arguments.length) {
            values.set(selector, value);
            return this;
          }
          return values.get(selector);
        },
        on(event, handler) {
          handlers.set(`${selector}:${event}`, handler);
          return this;
        },
        toggle() { return this; },
        prop(name, value) {
          if (name === "disabled") state.disabled = value;
          return this;
        },
      });
    }
    return controls.get(selector);
  };
  const notifications = [];
  const requests = [];
  const timers = [];
  const RED = {
    nodes: { registerType(type, definition) {
      assert.equal(type, "embed-config");
      this.definition = definition;
    } },
    notify: (...args) => notifications.push(args),
  };
  $.post = (url, body) => {
    requests.push({ url, body });
    const request = {
      done(callback) {
        callback(response);
        return request;
      },
      fail() { return request; },
    };
    return request;
  };

  vm.runInNewContext(script[1], {
    RED,
    $,
    setTimeout(callback) {
      timers.push(callback);
    },
  });
  RED.nodes.definition.oneditprepare();
  return {
    notifications,
    requests,
    state,
    values,
    label: RED.nodes.definition.label,
    click: () => handlers.get("#rc-embed-test:click").call(button),
    runTimers: () => timers.splice(0).forEach(callback => callback()),
  };
}

describe("embed-config editor connection test", () => {
  it("labels the config node with the selected backend, not Node-RED's reserved type", () => {
    const editor = createEditor({ ok: true, dims: 1536 }, "openai");

    assert.equal(
      editor.label.call({ type: "embed-config", backend: "openai", model: "text-embedding-3-small" }),
      "openai · text-embedding-3-small"
    );
    assert.equal(
      editor.label.call({ name: "Embeddings maison", type: "embed-config", backend: "ollama", model: "mxbai" }),
      "Embeddings maison"
    );
  });

  it("accepts a successful test and stores the detected dimensions", () => {
    const editor = createEditor({ ok: true, dims: 1536, model: "embed-model", type: "openai" });

    editor.click();

    assert.equal(editor.state.text, "✅ OK");
    assert.equal(editor.state.color, "green");
    assert.equal(editor.state.disabled, true);
    editor.runTimers();
    assert.equal(editor.state.text, "Tester");
    assert.equal(editor.state.disabled, false);
    assert.equal(editor.values.get("#node-config-input-dims"), 1536);
    assert.equal(editor.requests[0].url, "/redclaw/embed/test");
    assert.equal(editor.requests[0].body.apiKey, "test-key");
    assert.deepEqual(editor.notifications, []);
  });

  it("rejects an unsuccessful or malformed 2xx response without changing dimensions", () => {
    for (const response of [
      { ok: false, dims: 1536 },
      { ok: true, dims: 0 },
      { ok: true, dims: "1536" },
      null,
    ]) {
      const editor = createEditor(response);
      editor.values.set("#node-config-input-dims", 768);

      editor.click();

      assert.equal(editor.state.text, "❌ Erreur");
      assert.equal(editor.state.color, "red");
      assert.equal(editor.state.disabled, true);
      assert.equal(editor.values.get("#node-config-input-dims"), 768);
      assert.deepEqual(editor.notifications, [
        ["Erreur : réponse du test embedding invalide", "error"],
      ]);
      editor.runTimers();
      assert.equal(editor.state.disabled, false);
    }
  });
});
