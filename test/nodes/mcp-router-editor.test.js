const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadEditor() {
  const html = fs.readFileSync(
    path.join(__dirname, "../../nodes/mcp-router.html"),
    "utf8"
  );
  const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/);
  assert.ok(script, "the MCP Router editor script should be present");

  const RED = {
    nodes: {
      registerType(type, definition) {
        assert.equal(type, "mcp-router");
        this.definition = definition;
      },
    },
  };
  vm.runInNewContext(script[1], { RED });
  return RED.nodes.definition;
}

describe("mcp-router editor", () => {
  it("renders labels safely for malformed tool entries and preserves output indexes", () => {
    const editor = loadEditor();
    let getterInvoked = false;
    const accessorTool = {};
    Object.defineProperty(accessorTool, "name", {
      enumerable: true,
      get() {
        getterInvoked = true;
        return "unsafe";
      },
    });
    const node = {
      tools: [null, accessorTool, { name: "turn_on" }],
    };

    assert.equal(editor.label.call(node), "MCP Router (1 tool)");
    assert.equal(editor.outputLabels.call(node, 0), "→ adapter (configuration invalide)");
    assert.equal(editor.outputLabels.call(node, 1), "→ adapter (configuration invalide)");
    assert.equal(editor.outputLabels.call(node, 2), "→ adapter: turn_on");
    assert.equal(editor.outputLabels.call(node, 3), "⚡ Retour Orchestrateur");
    assert.equal(getterInvoked, false);
  });

  it("renders a usable label when the persisted tools field is not an array", () => {
    const editor = loadEditor();
    const node = { tools: { name: "invalid" } };

    assert.equal(editor.label.call(node), "MCP Router (0 tools)");
    assert.equal(editor.outputLabels.call(node, 0), "⚡ Retour Orchestrateur");
  });
});
