const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const helper = require("node-red-node-test-helper");
const neuroEmbed = require("../../nodes/neuro-embed.js");
const { loadContract, snapshot, validate } = require("../../lib/cognitive-contract");

helper.init(require.resolve("node-red"));

let storeDir;

function mockEmbedConfig(RED) {
  function MockEmbedConfigNode(config) {
    RED.nodes.createNode(this, config);
    this.embed = async text => text === "query" ? [0, 1] : [1, 0];
  }
  RED.nodes.registerType("embed-config", MockEmbedConfigNode);
}

afterEach(async () => {
  await helper.unload();
  if (storeDir) {
    fs.rmSync(storeDir, { recursive: true, force: true });
    storeDir = null;
  }
});

describe("neuro-embed", () => {
  function instantiateNode(config) {
    let registeredConstructor;
    const warnings = [];
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-embed-config-"));
    const RED = {
      settings: { userDir: storeDir },
      nodes: {
        createNode(node) {
          node.id = "config-test";
        },
        getNode(id) {
          return id === "embed-config-1"
            ? { embed: async () => [1, 0] }
            : null;
        },
        registerType(_name, constructor) {
          registeredConstructor = constructor;
        },
      },
      httpAdmin: { get() {} },
      auth: { needsPermission: () => () => {} },
    };
    neuroEmbed(RED);
    const node = new EventEmitter();
    node.status = () => {};
    node.warn = warning => warnings.push(warning);
    node.log = () => {};
    node.error = () => {};
    registeredConstructor.call(node, config);
    return { node, warnings };
  }

  it("does not invoke configuration accessors", () => {
    let getterInvoked = false;
    const config = {};
    for (const key of [
      "mode", "storeName", "topK", "threshold", "maxChars", "maxDocs",
      "metaFields", "embedConfig", "storeDir",
    ]) {
      Object.defineProperty(config, key, {
        enumerable: true,
        get() {
          getterInvoked = true;
          throw new Error(`${key} getter invoked`);
        },
      });
    }

    const { node, warnings } = instantiateNode(config);

    assert.equal(getterInvoked, false);
    assert.equal(node.mode, "both");
    assert.equal(node.storeName, "default");
    assert.equal(node.topK, 5);
    assert.equal(node.threshold, 0.5);
    assert.equal(node.maxChars, 2000);
    assert.equal(node.store.maxDocs, 10000);
    assert.deepEqual(node.metaFields, ["sessionId", "skill", "role"]);
    assert.equal(node.embedConfig, null);
    assert.equal(warnings.length, 9);
    node.store.destroy();
  });

  it("does not invoke configuration Proxy traps", () => {
    let trapInvoked = false;
    const config = new Proxy({}, {
      getOwnPropertyDescriptor() {
        trapInvoked = true;
        throw new Error("configuration Proxy trap invoked");
      },
    });

    const { node } = instantiateNode(config);

    assert.equal(trapInvoked, false);
    assert.equal(node.mode, "both");
    assert.equal(node.storeName, "default");
    assert.equal(node.topK, 5);
    assert.equal(node.embedConfig, null);
    node.store.destroy();
  });

  it("defaults malformed settings and keeps valid values within supported ranges", () => {
    const { node, warnings } = instantiateNode({
      mode: "invalid",
      storeName: "   ",
      topK: "21",
      threshold: "1.2",
      maxChars: "199",
      maxDocs: "99",
      metaFields: {},
      embedConfig: {},
      storeDir: {},
    });

    assert.equal(node.mode, "both");
    assert.equal(node.storeName, "default");
    assert.equal(node.topK, 5);
    assert.equal(node.threshold, 0.5);
    assert.equal(node.maxChars, 2000);
    assert.equal(node.store.maxDocs, 10000);
    assert.deepEqual(node.metaFields, ["sessionId", "skill", "role"]);
    assert.equal(node.embedConfig, null);
    assert.equal(warnings.length, 8);
    node.store.destroy();
  });

  it("accepts valid settings and resolves an explicit embedding reference", async () => {
    const { node, warnings } = instantiateNode({
      mode: "search",
      storeName: "  knowledge  ",
      topK: "20",
      threshold: 0,
      maxChars: 200,
      maxDocs: "100",
      metaFields: "sessionId,role",
      embedConfig: "embed-config-1",
    });

    assert.equal(node.mode, "search");
    assert.equal(node.storeName, "knowledge");
    assert.equal(node.topK, 20);
    assert.equal(node.threshold, 0);
    assert.equal(node.maxChars, 200);
    assert.equal(node.store.maxDocs, 100);
    assert.deepEqual(node.metaFields, ["sessionId", "role"]);
    assert.deepEqual(await node.embedConfig.embed("example"), [1, 0]);
    assert.deepEqual(warnings, []);
    node.store.destroy();
  });

  it("exposes the configured vector-store directory in the palette editor", () => {
    const html = fs.readFileSync(
      path.join(__dirname, "../../nodes/neuro-embed.html"),
      "utf8"
    );
    assert.match(html, /id="node-input-storeDir"/);
    assert.match(html, /Dossier de persistance des vecteurs/);
    assert.match(html, /profil utilisateur Node-RED/);
  });

  it("encodes the store name and reports failed stats requests", async () => {
    const html = fs.readFileSync(
      path.join(__dirname, "../../nodes/neuro-embed.html"),
      "utf8"
    );
    const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/);
    assert.ok(script, "the node editor registration script should be present");
    let definition;
    const handlers = new Map();
    const values = new Map([["#node-input-storeName", "store/one?x"]]);
    const controls = new Map();
    const $ = selector => {
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
        });
      }
      return controls.get(selector);
    };
    const notifications = [];
    const responses = [
      { ok: true, json: async () => ({ name: "store/one?x", docs: 2, dims: 3 }) },
      { ok: false, status: 403, json: async () => ({ error: "Accès refusé" }) },
    ];
    const requestedUrls = [];
    const RED = {
      nodes: { registerType(type, nodeDefinition) {
        assert.equal(type, "neuro-embed");
        definition = nodeDefinition;
      } },
      notify: (...args) => notifications.push(args),
    };
    vm.runInNewContext(script[1], {
      RED,
      $,
      fetch: async url => {
        requestedUrls.push(url);
        return responses.shift();
      },
      encodeURIComponent,
    });
    definition.oneditprepare.call({ topK: 5 });

    await handlers.get("#rc-embed-stats:click")();
    assert.equal(requestedUrls[0], "/redclaw/vectors/store%2Fone%3Fx");
    assert.deepEqual(notifications[0], [
      'Store "store/one?x" : 2 docs · 3 dims',
      "info",
    ]);

    await handlers.get("#rc-embed-stats:click")();
    assert.deepEqual(notifications[1], ["Accès refusé", "error"]);
  });

  it("preserves a legacy k value when opening the palette editor", () => {
    const htmlPath = path.join(__dirname, "../../nodes/neuro-embed.html");
    const html = fs.readFileSync(htmlPath, "utf8");
    const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/);
    assert.ok(script, "the node editor registration script should be present");

    let editorDefinition;
    const values = new Map();
    const controls = new Map();
    const $ = selector => {
      if (!controls.has(selector)) {
        controls.set(selector, {
          val(value) {
            if (arguments.length) {
              values.set(selector, value);
              return this;
            }
            return values.get(selector);
          },
          on() { return this; },
          toggle() { return this; },
        });
      }
      return controls.get(selector);
    };
    const RED = {
      nodes: {
        registerType(type, definition) {
          assert.equal(type, "neuro-embed");
          editorDefinition = definition;
        },
      },
    };
    vm.runInNewContext(script[1], { RED, $ });

    editorDefinition.oneditprepare.call({ k: "7" });
    assert.equal(values.get("#node-input-topK"), "7");

    values.clear();
    editorDefinition.oneditprepare.call({ k: "7", topK: 9 });
    assert.equal(values.has("#node-input-topK"), false);
  });

  it("stores the input, retrieves relevant context, and respects the contract", (t, done) => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-embed-node-"));
    const flow = [
      { id: "embed-config-1", type: "embed-config" },
      {
        id: "embed",
        type: "neuro-embed",
        embedConfig: "embed-config-1",
        mode: "both",
        storeName: "roundtrip",
        storeDir,
        threshold: 0.5,
        maxChars: 500,
        wires: [["result"], ["empty"]],
      },
      { id: "result", type: "helper" },
      { id: "empty", type: "helper" },
    ];

    helper.load([mockEmbedConfig, neuroEmbed], flow, () => {
      const node = helper.getNode("embed");
      const contract = loadContract("neuro-embed");
      const input = {
        payload: "The office temperature is 21 degrees",
        sessionId: "office-session",
        correlationId: "embed-1",
      };
      const before = snapshot(input);

      helper.getNode("empty").on("input", msg => done(new Error(msg.embed_error || "unexpected empty result")));
      helper.getNode("result").on("input", msg => {
        try {
          const result = validate(contract, before, msg);
          assert.equal(result.ok, true, result.violations.join("; "));
          assert.equal(msg.payload, input.payload);
          assert.equal(msg.embed_context, input.payload);
          assert.equal(msg.embed_retrieved, 1);
          assert.equal(msg.embed_chars, input.payload.length);
          assert.deepEqual(msg.embed_vector, [1, 0]);
          assert.equal(msg.embed_results[0].metadata.sessionId, "office-session");
          assert.equal(msg.correlationId, "embed-1");
          assert.equal(node.store.size(), 1);
          done();
        } catch (error) {
          done(error);
        }
      });

      node.receive(input);
    });
  });

  it("honors an explicit zero similarity threshold", (t, done) => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-embed-zero-threshold-"));
    const flow = [
      { id: "embed-config-1", type: "embed-config" },
      {
        id: "embed",
        type: "neuro-embed",
        embedConfig: "embed-config-1",
        mode: "search",
        storeName: "zero-threshold",
        storeDir,
        threshold: 0,
        wires: [["result"], ["empty"]],
      },
      { id: "result", type: "helper" },
      { id: "empty", type: "helper" },
    ];

    helper.load([mockEmbedConfig, neuroEmbed], flow, () => {
      const node = helper.getNode("embed");
      node.store.upsert("orthogonal", "Previously stored document", [1, 0]);

      helper.getNode("empty").on("input", msg => {
        done(new Error(msg.embed_error || "zero threshold must include a zero-similarity result"));
      });
      helper.getNode("result").on("input", msg => {
        try {
          assert.equal(node.threshold, 0);
          assert.equal(msg.embed_retrieved, 1);
          assert.equal(msg.embed_results[0].text, "Previously stored document");
          assert.equal(msg.embed_results[0].score, 0);
          done();
        } catch (error) {
          done(error);
        }
      });

      node.receive({ payload: "query", embed_action: "search" });
    });
  });

  it("uses the default for a malformed or out-of-range similarity threshold", (t, done) => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-embed-invalid-threshold-"));
    const flow = [
      { id: "embed-config-1", type: "embed-config" },
      {
        id: "embed",
        type: "neuro-embed",
        embedConfig: "embed-config-1",
        mode: "search",
        storeName: "invalid-threshold",
        storeDir,
        threshold: "1.2",
        wires: [["result"], ["empty"]],
      },
      { id: "result", type: "helper" },
      { id: "empty", type: "helper" },
    ];

    helper.load([mockEmbedConfig, neuroEmbed], flow, () => {
      try {
        assert.equal(helper.getNode("embed").threshold, 0.5);
        done();
      } catch (error) {
        done(error);
      }
    });
  });

  it("validates imported search and storage limits against editor constraints", (t, done) => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-embed-invalid-limits-"));
    const flow = [
      { id: "embed-config-1", type: "embed-config" },
      {
        id: "embed",
        type: "neuro-embed",
        embedConfig: "embed-config-1",
        mode: "search",
        storeName: "invalid-limits",
        storeDir,
        topK: "21",
        maxChars: "199",
        maxDocs: "99",
        wires: [["result"], ["empty"]],
      },
      { id: "result", type: "helper" },
      { id: "empty", type: "helper" },
    ];

    helper.load([mockEmbedConfig, neuroEmbed], flow, () => {
      try {
        const node = helper.getNode("embed");
        assert.equal(node.topK, 5);
        assert.equal(node.maxChars, 2000);
        assert.equal(node.store.maxDocs, 10000);
        done();
      } catch (error) {
        done(error);
      }
    });

  });

  it("loads the legacy k setting from existing flows", (t, done) => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-embed-legacy-top-k-"));
    const flow = [
      { id: "embed-config-1", type: "embed-config" },
      {
        id: "embed",
        type: "neuro-embed",
        embedConfig: "embed-config-1",
        mode: "search",
        storeName: "legacy-top-k",
        storeDir,
        k: "7",
        wires: [["result"], ["empty"]],
      },
      { id: "result", type: "helper" },
      { id: "empty", type: "helper" },
    ];

    helper.load([mockEmbedConfig, neuroEmbed], flow, () => {
      try {
        assert.equal(helper.getNode("embed").topK, 7);
        done();
      } catch (error) {
        done(error);
      }
    });
  });
});
