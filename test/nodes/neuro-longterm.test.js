const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const helper = require("node-red-node-test-helper");
const neuroLongterm = require("../../nodes/neuro-longterm.js");
const longtermMemory = require("../../lib/longterm-memory");
const { loadContract, snapshot, validate } = require("../../lib/cognitive-contract");

helper.init(require.resolve("node-red"));

let originalMemories;
let originalStorageDir;
let originalFile;
let storageDir;
let skillName;

beforeEach(() => {
  originalMemories = longtermMemory._memories;
  originalStorageDir = longtermMemory.storageDir;
  originalFile = longtermMemory._file;
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-longterm-node-"));
  skillName = `memory-test-${randomUUID()}`;
  longtermMemory._memories = new Map();
  longtermMemory.storageDir = storageDir;
  longtermMemory._file = path.join(storageDir, "memories.json");
});

afterEach(async () => {
  await helper.unload();
  longtermMemory.destroy();
  longtermMemory._memories = originalMemories;
  longtermMemory.storageDir = originalStorageDir;
  longtermMemory._file = originalFile;
  fs.rmSync(storageDir, { recursive: true, force: true });
});

describe("neuro-longterm", () => {
  function instantiateNode(config) {
    let registeredConstructor;
    const warnings = [];
    const RED = {
      nodes: {
        createNode(node) {
          node.id = "config-test";
        },
        registerType(_name, constructor) {
          registeredConstructor = constructor;
        },
      },
      httpAdmin: {
        get() {},
      },
      auth: {
        needsPermission() {
          return () => {};
        },
      },
    };
    neuroLongterm(RED);
    const node = new EventEmitter();
    node.status = () => {};
    node.warn = warning => warnings.push(warning);
    node.log = () => {};
    registeredConstructor.call(node, config);
    return { node, warnings };
  }

  it("does not invoke configuration accessors", () => {
    let getterInvoked = false;
    const config = {};
    for (const key of ["mode", "skillName", "memType", "limit"]) {
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
    assert.equal(node.mode, "query");
    assert.equal(node.skillName, "");
    assert.equal(node.memType, "pattern");
    assert.equal(node.limit, 5);
    assert.equal(warnings.length, 4);
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
    assert.equal(node.mode, "query");
    assert.equal(node.skillName, "");
    assert.equal(node.memType, "pattern");
    assert.equal(node.limit, 5);
  });

  it("defaults invalid mode, memory type, skill name, and limit", () => {
    const { node, warnings } = instantiateNode({
      mode: "unsupported",
      skillName: {},
      memType: "unknown",
      limit: 21,
    });

    assert.equal(node.mode, "query");
    assert.equal(node.skillName, "");
    assert.equal(node.memType, "pattern");
    assert.equal(node.limit, 5);
    assert.equal(warnings.length, 4);
  });

  it("accepts supported auto mode, memory type, and limit values", () => {
    const { node, warnings } = instantiateNode({
      mode: "auto",
      skillName: "  energy  ",
      memType: "fact",
      limit: "20",
    });

    assert.equal(node.mode, "auto");
    assert.equal(node.skillName, "energy");
    assert.equal(node.memType, "fact");
    assert.equal(node.limit, 20);
    assert.deepEqual(warnings, []);
  });

  it("defaults invalid imported query limits to the supported range", (t, done) => {
    const flow = [
      { id: "memory", type: "neuro-longterm", mode: "query", limit: "0", wires: [["out"], ["error"]] },
      { id: "out", type: "helper" },
      { id: "error", type: "helper" },
    ];

    helper.load(neuroLongterm, flow, () => {
      try {
        assert.equal(helper.getNode("memory").limit, 5);
        done();
      } catch (error) {
        done(error);
      }
    });
  });

  it("records flow-derived facts and makes them retrievable as context", (t, done) => {
    const flow = [
      { id: "memory", type: "neuro-longterm", mode: "record", skillName,
        memType: "pattern", wires: [["recorded"], ["error"]] },
      { id: "recorded", type: "helper" },
      { id: "error", type: "helper" },
    ];
    helper.load(neuroLongterm, flow, () => {
      const node = helper.getNode("memory");
      const contract = loadContract("neuro-longterm");
      const input = {
        payload: [{ suggestion: "Check the meter before optimizing" }],
        correlationId: "memory-correlation",
      };
      const before = snapshot(input);
      helper.getNode("error").on("input", msg => done(new Error(msg.payload)));
      helper.getNode("recorded").on("input", msg => {
        if (!Array.isArray(msg.payload)) return;
        try {
          const result = validate(contract, before, msg);
          assert.equal(result.ok, true, result.violations.join("; "));
          assert.equal(msg.correlationId, "memory-correlation");
          assert.equal(msg.payload.length, 1);
          assert.equal(msg.payload[0].content, "Check the meter before optimizing");
          assert.equal(msg.payload[0].skill, skillName);
          node.mode = "query";
          const query = { payload: "query", correlationId: "memory-correlation" };
          node.receive(query);
        } catch (error) {
          done(error);
        }
      });
      helper.getNode("recorded").on("input", msg => {
        if (!msg.longterm_context) return;
        const queryBefore = { payload: "query", correlationId: "memory-correlation" };
        try {
          const result = validate(contract, queryBefore, msg);
          assert.equal(result.ok, true, result.violations.join("; "));
          assert.match(msg.longterm_context, /Check the meter before optimizing/);
          assert.equal(msg.longterm_items.length, 1);
          assert.equal(msg.correlationId, "memory-correlation");
          done();
        } catch (error) {
          done(error);
        }
      });
      node.receive(input);
    });
  });
});
