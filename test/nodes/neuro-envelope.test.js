const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const helper = require("node-red-node-test-helper");
const neuroEnvelope = require("../../nodes/neuro-envelope.js");
const { loadContract, snapshot, validate } = require("../../lib/cognitive-contract");

helper.init(require.resolve("node-red"));

describe("neuro-envelope", () => {
  afterEach(() => helper.unload());

  function loadMode(mode, done, check) {
    const flow = [
      { id: "envelope", type: "neuro-envelope", mode, nodeName: "envelope-test",
        wires: [["valid"], ["invalid"]] },
      { id: "valid", type: "helper" },
      { id: "invalid", type: "helper" },
    ];

    helper.load(neuroEnvelope, flow, () => {
      const node = helper.getNode("envelope");
      const contract = loadContract("neuro-envelope");
      check({ node, contract, valid: helper.getNode("valid"), invalid: helper.getNode("invalid"), done });
    });
  }

  it("wraps the original payload and appends a trace entry", (t, done) => {
    loadMode("wrap", done, ({ node, contract, valid, invalid }) => {
      const input = { payload: { temperature: 21 }, topic: "climate", correlationId: "env-1" };
      const before = snapshot(input);
      invalid.on("input", () => done(new Error("wrap must use output 1")));
      valid.on("input", msg => {
        try {
          const result = validate(contract, before, msg);
          assert.equal(result.ok, true, result.violations.join("; "));
          assert.deepEqual(msg.neuro.data, { payload: { temperature: 21 }, topic: "climate" });
          assert.equal(msg.neuro.intent, "climate");
          assert.equal(msg.neuro.source, `node:${node.id.slice(0, 8)}`);
          assert.equal(msg.neuro.trace.at(-1).node, "envelope-test");
          assert.equal(msg.correlationId, "env-1");
          done();
        } catch (error) {
          done(error);
        }
      });
      node.receive(input);
    });
  });

  it("preserves an explicitly configured priority of zero", (t, done) => {
    const flow = [
      { id: "envelope", type: "neuro-envelope", mode: "wrap", priority: 0,
        wires: [["valid"], ["invalid"]] },
      { id: "valid", type: "helper" },
      { id: "invalid", type: "helper" },
    ];

    helper.load(neuroEnvelope, flow, () => {
      const node = helper.getNode("envelope");
      helper.getNode("invalid").on("input", () => done(new Error("wrap must use output 1")));
      helper.getNode("valid").on("input", msg => {
        try {
          assert.equal(node.priority, 0);
          assert.equal(msg.neuro.priority, 0);
          done();
        } catch (error) {
          done(error);
        }
      });
      node.receive({ payload: "low-priority event" });
    });
  });

  for (const configuredPriority of ["50junk", "50.5"]) {
    it(`defaults malformed configured priority ${configuredPriority}`, (t, done) => {
      const flow = [
        { id: "envelope", type: "neuro-envelope", mode: "wrap",
          priority: configuredPriority, wires: [["valid"], ["invalid"]] },
        { id: "valid", type: "helper" },
        { id: "invalid", type: "helper" },
      ];

      helper.load(neuroEnvelope, flow, () => {
        try {
          assert.equal(helper.getNode("envelope").priority, 50);
          done();
        } catch (error) {
          done(error);
        }
      });
    });
  }

  it("defaults malformed string configuration fields without coercing them", (t, done) => {
    const flow = [
      {
        id: "envelope",
        type: "neuro-envelope",
        mode: {},
        nodeName: {},
        msgType: {},
        source: {},
        intent: {},
        wires: [["valid"], ["invalid"]],
      },
      { id: "valid", type: "helper" },
      { id: "invalid", type: "helper" },
    ];

    helper.load(neuroEnvelope, flow, () => {
      try {
        const node = helper.getNode("envelope");
        assert.equal(node.mode, "wrap");
        assert.equal(node.nodeName, "envelope");
        assert.equal(node.msgType, "event");
        assert.equal(node.source, "");
        assert.equal(node.intent, "");
        done();
      } catch (error) {
        done(error);
      }
    });
  });

  it("defaults unsupported modes and blank trace node names", () => {
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
    };
    neuroEnvelope(RED);
    const node = new EventEmitter();
    node.status = () => {};
    node.warn = warning => warnings.push(warning);
    node.log = () => {};

    registeredConstructor.call(node, { mode: "unsupported", nodeName: "   " });

    assert.equal(node.mode, "wrap");
    assert.equal(node.nodeName, "envelope");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /mode.*unsupported/);
  });

  it("does not invoke configuration accessors", () => {
    let registeredConstructor;
    let getterInvoked = false;
    const warnings = [];
    const config = {};
    for (const key of ["mode", "nodeName", "msgType", "source", "intent", "priority", "strict"]) {
      Object.defineProperty(config, key, {
        enumerable: true,
        get() {
          getterInvoked = true;
          throw new Error(`${key} getter invoked`);
        },
      });
    }
    const RED = {
      nodes: {
        createNode(node) {
          node.id = "config-test";
        },
        registerType(_name, constructor) {
          registeredConstructor = constructor;
        },
      },
    };
    neuroEnvelope(RED);
    const node = new EventEmitter();
    node.status = () => {};
    node.warn = warning => warnings.push(warning);
    node.log = () => {};

    registeredConstructor.call(node, config);

    assert.equal(getterInvoked, false);
    assert.equal(node.mode, "wrap");
    assert.equal(node.nodeName, "envelope");
    assert.equal(node.msgType, "event");
    assert.equal(node.priority, 50);
    assert.equal(node.strict, false);
    assert.equal(warnings.length, 7);
  });

  it("warns when a configured priority is outside the supported range", () => {
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
    };
    neuroEnvelope(RED);
    const node = new EventEmitter();
    node.status = () => {};
    node.warn = warning => warnings.push(warning);
    node.log = () => {};

    registeredConstructor.call(node, { priority: 101 });

    assert.equal(node.priority, 50);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /priority.*integer between 0 and 100/);
  });

  it("warns and defaults when strict configuration is not boolean", () => {
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
    };
    neuroEnvelope(RED);
    const node = new EventEmitter();
    node.status = () => {};
    node.warn = warning => warnings.push(warning);
    node.log = () => {};

    registeredConstructor.call(node, { strict: "true" });

    assert.equal(node.strict, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /strict.*boolean/);
  });

  it("does not coerce non-primitive configured priorities", (t, done) => {
    let coercionInvoked = false;
    const configuredPriority = {
      valueOf() {
        coercionInvoked = true;
        throw new Error("priority coercion invoked");
      },
    };
    const flow = [
      { id: "envelope", type: "neuro-envelope", mode: "wrap",
        priority: configuredPriority, wires: [["valid"], ["invalid"]] },
      { id: "valid", type: "helper" },
      { id: "invalid", type: "helper" },
    ];

    helper.load(neuroEnvelope, flow, () => {
      try {
        assert.equal(helper.getNode("envelope").priority, 50);
        assert.equal(coercionInvoked, false);
        done();
      } catch (error) {
        done(error);
      }
    });
  });

  it("reports a null input priority instead of replacing it with the configured default", (t, done) => {
    loadMode("wrap", done, ({ node, valid, invalid }) => {
      valid.on("input", () => done(new Error("null priority must not be wrapped")));
      invalid.on("input", () => done(new Error("wrap must not route a null priority")));
      node.error = error => {
        try {
          assert.match(String(error), /priority must be between 0 and 100/);
          done();
        } catch (assertionError) {
          done(assertionError);
        }
      };
      node.receive({ payload: "event", priority: null });
    });
  });

  it("wrap refuses accessor-backed input fields without invoking getters", (t, done) => {
    loadMode("wrap", done, ({ node }) => {
      let getterInvoked = false;
      const input = {};
      Object.defineProperty(input, "payload", {
        enumerable: true,
        get() {
          getterInvoked = true;
          throw new Error("payload getter invoked");
        },
      });

      node.error = error => {
        try {
          assert.match(String(error), /msg\.payload must be a data property/);
          assert.equal(getterInvoked, false);
          done();
        } catch (assertionError) {
          done(assertionError);
        }
      };
      node.receive(input);
    });
  });

  it("wrap reports invalid explicitly supplied session IDs", (t, done) => {
    loadMode("wrap", done, ({ node, valid, invalid }) => {
      valid.on("input", () => done(new Error("invalid sessionId must not be wrapped")));
      invalid.on("input", () => done(new Error("wrap must not route invalid sessionId")));
      node.error = error => {
        try {
          assert.match(String(error), /sessionId must be strings/);
          done();
        } catch (assertionError) {
          done(assertionError);
        }
      };
      node.receive({ payload: "event", sessionId: 0 });
    });
  });

  it("unwraps without destroying neuro metadata", (t, done) => {
    loadMode("unwrap", done, ({ node, contract, valid, invalid }) => {
      const input = {
        payload: "wrapper",
        correlationId: "env-2",
        neuro: {
          id: "existing",
          type: "event",
          source: "sensor",
          data: { payload: { temperature: 19 } },
          trace: [],
        },
      };
      const before = snapshot(input);
      invalid.on("input", () => done(new Error("unwrap must use output 1")));
      valid.on("input", msg => {
        try {
          const result = validate(contract, before, msg);
          assert.equal(result.ok, true, result.violations.join("; "));
          assert.deepEqual(msg.payload, { temperature: 19 });
          assert.equal(msg.neuro.id, "existing");
          assert.equal(msg.neuro.trace.at(-1).action, "unwrap");
          assert.equal(msg.correlationId, "env-2");
          done();
        } catch (error) {
          done(error);
        }
      });
      node.receive(input);
    });
  });

  it("unwraps an explicitly present undefined payload", (t, done) => {
    loadMode("unwrap", done, ({ node, valid, invalid }) => {
      const input = {
        payload: "wrapper",
        neuro: {
          id: "existing",
          type: "event",
          source: "sensor",
          data: { payload: undefined },
          trace: [],
        },
      };
      valid.on("input", msg => {
        try {
          const descriptor = Object.getOwnPropertyDescriptor(msg, "payload");
          assert.equal(Object.hasOwn(msg, "payload"), true);
          assert.equal(descriptor.value, undefined);
          done();
        } catch (error) {
          done(error);
        }
      });
      invalid.on("input", () => done(new Error("unwrap must use output 1")));
      node.emit("input", input, outputs => valid.emit("input", outputs[0][0]), done);
    });
  });

  it("unwrap passes through accessor-backed metadata without invoking getters", (t, done) => {
    loadMode("unwrap", done, ({ node, valid, invalid }) => {
      let getterInvoked = false;
      const neuro = {};
      Object.defineProperty(neuro, "data", {
        enumerable: true,
        get() {
          getterInvoked = true;
          throw new Error("neuro data getter invoked");
        },
      });
      const input = { payload: "unchanged", neuro };
      valid.on("input", msg => {
        try {
          assert.equal(msg.payload, "unchanged");
          assert.equal(getterInvoked, false);
          done();
        } catch (error) {
          done(error);
        }
      });
      invalid.on("input", () => done(new Error("unwrap must use output 1")));
      node.emit("input", input, outputs => valid.emit("input", outputs[0][0]), done);
    });
  });

  it("unwrap doesn't invoke a payload setter when replacing the outer payload", (t, done) => {
    loadMode("unwrap", done, ({ node, valid, invalid }) => {
      let setterInvoked = false;
      const input = {
        neuro: {
          id: "existing",
          type: "event",
          source: "sensor",
          data: { payload: "wrapped" },
          trace: [],
        },
      };
      Object.defineProperty(input, "payload", {
        enumerable: true,
        configurable: true,
        get() {
          return "original";
        },
        set() {
          setterInvoked = true;
          throw new Error("payload setter invoked");
        },
      });
      valid.on("input", msg => {
        try {
          assert.equal(setterInvoked, false);
          assert.equal(msg.payload, "wrapped");
          done();
        } catch (error) {
          done(error);
        }
      });
      invalid.on("input", () => done(new Error("unwrap must use output 1")));
      node.emit("input", input, outputs => valid.emit("input", outputs[0][0]), done);
    });
  });

  it("unwrap reports when a non-configurable payload cannot be replaced", (t, done) => {
    loadMode("unwrap", done, ({ node, valid, invalid }) => {
      let getterInvoked = false;
      let reportedError = false;
      const input = {
        neuro: {
          id: "existing",
          type: "event",
          source: "sensor",
          data: { payload: "wrapped" },
          trace: [],
        },
      };
      Object.defineProperty(input, "payload", {
        enumerable: true,
        configurable: false,
        get() {
          getterInvoked = true;
          return "original";
        },
      });

      node.error = (error, errorMessage) => {
        assert.match(String(error), /Impossible de remplacer msg\.payload/);
        assert.equal(errorMessage, input);
        assert.equal(getterInvoked, false);
        reportedError = true;
      };
      valid.on("input", msg => {
        try {
          assert.equal(reportedError, true);
          assert.equal(getterInvoked, false);
          assert.equal(Object.getOwnPropertyDescriptor(msg, "payload").get instanceof Function, true);
          done();
        } catch (error) {
          done(error);
        }
      });
      invalid.on("input", () => done(new Error("unwrap must use output 1")));
      node.emit("input", input, outputs => valid.emit("input", outputs[0][0]), done);
    });
  });

  it("routes invalid neuro messages to output 2 in validate mode", (t, done) => {
    loadMode("validate", done, ({ node, contract, valid, invalid }) => {
      const input = { payload: "not wrapped", correlationId: "env-3" };
      const before = snapshot(input);
      valid.on("input", () => done(new Error("invalid message must use output 2")));
      invalid.on("input", msg => {
        try {
          const result = validate(contract, before, msg);
          assert.equal(result.ok, true, result.violations.join("; "));
          assert.equal(msg.payload, "not wrapped");
          assert.equal(msg.correlationId, "env-3");
          assert.equal(msg.neuro, undefined);
          done();
        } catch (error) {
          done(error);
        }
      });
      node.receive(input);
    });
  });
});
