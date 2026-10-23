const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  checkNode,
  topLevelKeys,
  extractObject,
  htmlDefaults,
  routePattern,
  jsRoutes,
  htmlCalls,
  readStringArg,
} = require("../../lib/editor-consistency");

test("extracts top-level defaults while ignoring nested object properties", () => {
  assert.deepEqual(topLevelKeys('{ name: { value: "x", nested: { deep: true } }, outputs: { value: 2 }, enabled: { value: true } }'), [
    "name",
    "outputs",
    "enabled",
  ]);
  assert.equal(extractObject("defaults: { name: { value: 1 } }", "defaults: "), "{ name: { value: 1 } }");
  assert.deepEqual([...htmlDefaults('<script>defaults: { name: { value: "x" }, enabled: { value: true } }</script>')], [
    "name",
    "enabled",
  ]);
});

test("recognizes route parameters, admin routes, and editor endpoint calls", () => {
  assert.equal(routePattern("/redclaw/skills/:name").test("/redclaw/skills/weather"), true);
  assert.equal(routePattern("/redclaw/skills/:name").test("/redclaw/skills/a/b"), false);
  assert.deepEqual(jsRoutes('RED.httpAdmin.get("/redclaw/skills/:name", handler);'), ["/redclaw/skills/:name"]);
  assert.deepEqual(
    htmlCalls('fetch("/redclaw/skills"); $.post(`/redclaw/skills/${encodeURIComponent(name)}`); $.ajax("/redclaw/config?fresh=1");'),
    ["/redclaw/skills", "/redclaw/skills/X", "/redclaw/config"],
  );
  assert.deepEqual(readStringArg('`/redclaw/item/${name}`', 0), { text: "/redclaw/item/\u0000" });
});

test("reports editor/runtime mismatches and passes a consistent node", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rc-editor-consistency-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const jsPath = path.join(directory, "sample.js");
  const htmlPath = path.join(directory, "sample.html");
  const js = 'RED.nodes.registerType("sample", function(config) { RED.httpAdmin.get("/redclaw/items/:id", handler); this.value = config.value; });';
  fs.writeFileSync(jsPath, js);
  fs.writeFileSync(htmlPath, '<script>RED.nodes.registerType("sample", { defaults: { value: { value: "" } } });</script><div data-template-name="sample" data-help-name="sample"></div><script>fetch(`/redclaw/items/${id}`);</script>');

  assert.deepEqual(checkNode("sample", jsPath, [js]), { errors: [], warnings: [] });

  fs.writeFileSync(htmlPath, '<script>RED.nodes.registerType("other", { defaults: { missing: { value: "" } } });</script><div data-template-name="other"></div><script>fetch("/redclaw/not-found");</script>');
  const result = checkNode("sample", jsPath, [js]);
  assert.ok(result.errors.some(error => error.includes("n'enregistre pas \"sample\"")));
  assert.ok(result.errors.some(error => error.includes('data-template-name="sample" absent')));
  assert.ok(result.errors.some(error => error.includes("config.value")));
  assert.ok(result.errors.some(error => error.includes("/redclaw/not-found")));
  assert.ok(result.warnings.some(warning => warning.includes("data-help-name")));
});

test("provides a valid JSON example for the REST LLM body template", () => {
  const htmlPath = path.join(__dirname, "../../nodes/llm-config.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  const placeholder = html.match(/id="node-config-input-restBodyTpl"[^>]*placeholder='([^']+)'/);

  assert.ok(placeholder, "the REST body template example should be present");
  const example = placeholder[1].replace(/{{(?:model|system|user)}}/g, "example");
  assert.deepEqual(JSON.parse(example), {
    model: "example",
    system: "example",
    prompt: "example",
  });
});
