const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const helper = require("node-red-node-test-helper");
const neuroTrust = require("../../nodes/neuro-trust.js");
const skillTrust = require("../../lib/skill-trust");
const { loadContract, snapshot, validate } = require("../../lib/cognitive-contract");

helper.init(require.resolve("node-red"));

let originalStorageDir;
let originalFile;
let storageDir;

beforeEach(() => {
  originalStorageDir = skillTrust.storageDir;
  originalFile = skillTrust._file;
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-trust-node-"));
  skillTrust.storageDir = storageDir;
  skillTrust._file = path.join(storageDir, "trust.json");
  skillTrust._trust.clear();
});

afterEach(async () => {
  await helper.unload();
  skillTrust.destroy();
  skillTrust._trust.clear();
  skillTrust.storageDir = originalStorageDir;
  skillTrust._file = originalFile;
  fs.rmSync(storageDir, { recursive: true, force: true });
});

describe("neuro-trust", () => {
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
    neuroTrust(RED);
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
    for (const key of ["mode", "threshold", "alertOnFailure"]) {
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
    assert.equal(node.mode, "check");
    assert.equal(node.threshold, 0.7);
    assert.equal(node.alertOnFailure, true);
    assert.equal(warnings.length, 3);
  });

  it("defaults malformed modes and alert flags with warnings", () => {
    const { node, warnings } = instantiateNode({
      mode: "unsupported",
      threshold: 1.2,
      alertOnFailure: "false",
    });

    assert.equal(node.mode, "check");
    assert.equal(node.threshold, 0.7);
    assert.equal(node.alertOnFailure, true);
    assert.equal(warnings.length, 3);
    assert.match(warnings[0], /mode.*unsupported/);
    assert.match(warnings[1], /threshold.*between 0 and 1/);
    assert.match(warnings[2], /alertOnFailure.*boolean/);
  });

  it("preserves valid false alert flags and zero thresholds", () => {
    const { node, warnings } = instantiateNode({
      mode: "record",
      threshold: 0,
      alertOnFailure: false,
    });

    assert.equal(node.mode, "record");
    assert.equal(node.threshold, 0);
    assert.equal(node.alertOnFailure, false);
    assert.deepEqual(warnings, []);
  });

  it("check mode permits an unseen tool with neutral prior and obeys the contract", (t, done) => {
    const flow = [
      { id: "trust", type: "neuro-trust", mode: "check", threshold: 0.7,
        wires: [["ok"], ["review"]] },
      { id: "ok", type: "helper" },
      { id: "review", type: "helper" },
    ];

    helper.load(neuroTrust, flow, () => {
      const node = helper.getNode("trust");
      const contract = loadContract("neuro-trust");
      const input = {
        payload: { command: "inspect" },
        sessionId: "trust-node-test",
        redclaw: { tool: "inspect" },
      };
      const before = snapshot(input);
      helper.getNode("review").on("input", () => done(new Error("unseen tool should not require review")));
      helper.getNode("ok").on("input", msg => {
        try {
          const result = validate(contract, before, msg);
          assert.equal(result.ok, true, result.violations.join("; "));
          assert.equal(msg.redclaw_trust.trustScore, 1);
          assert.equal(msg.redclaw_trust.totalCalls, 0);
          assert.equal(msg.trust_context, "");
          assert.deepEqual(msg.payload, { command: "inspect" });
          done();
        } catch (error) {
          done(error);
        }
      });
      node.receive(input);
    });
  });

  it("honors a zero trust threshold instead of applying the default", (t, done) => {
    for (let i = 0; i < 3; i++) skillTrust.record("trust-node-test", "flaky", false, 1, "offline");
    const flow = [
      { id: "trust", type: "neuro-trust", mode: "check", threshold: 0,
        wires: [["ok"], ["review"]] },
      { id: "ok", type: "helper" },
      { id: "review", type: "helper" },
    ];

    helper.load(neuroTrust, flow, () => {
      const node = helper.getNode("trust");
      helper.getNode("review").on("input", () => done(new Error("threshold 0 must not route a score to review")));
      helper.getNode("ok").on("input", msg => {
        try {
          assert.equal(node.threshold, 0);
          assert.equal(msg.redclaw_trust.trustScore, 0.2);
          done();
        } catch (error) {
          done(error);
        }
      });
      node.receive({
        sessionId: "trust-node-test",
        redclaw: { tool: "flaky" },
      });
    });
  });

  it("uses the default for a malformed trust threshold", (t, done) => {
    const flow = [
      { id: "trust", type: "neuro-trust", mode: "check", threshold: "0.2junk",
        wires: [["ok"], ["review"]] },
      { id: "ok", type: "helper" },
      { id: "review", type: "helper" },
    ];

    helper.load(neuroTrust, flow, () => {
      try {
        assert.equal(helper.getNode("trust").threshold, 0.7);
        done();
      } catch (error) {
        done(error);
      }
    });
  });

  it("record mode relays the return unchanged and emits a low-trust failure alert", (t, done) => {
    const flow = [
      { id: "trust", type: "neuro-trust", mode: "record", threshold: 0.7,
        alertOnFailure: true, wires: [["relay"], ["alert"]] },
      { id: "relay", type: "helper" },
      { id: "alert", type: "helper" },
    ];

    helper.load(neuroTrust, flow, () => {
      const node = helper.getNode("trust");
      const contract = loadContract("neuro-trust");
      const input = {
        payload: { result: "failed" },
        sessionId: "trust-node-test",
        redclaw: { tool: "fragile_tool" },
        redclaw_call_started_at: Date.now() - 10,
        redclaw_error: "tool unavailable",
        correlationId: "trust-correlation",
      };
      const before = snapshot(input);
      let relayed = false;
      let alerted = false;

      function finish() {
        if (relayed && alerted) done();
      }

      helper.getNode("relay").on("input", msg => {
        try {
          const relayMessage = { ...msg };
          delete relayMessage._msgid;
          assert.deepEqual(relayMessage, before);
          relayed = true;
          finish();
        } catch (error) {
          done(error);
        }
      });
      helper.getNode("alert").on("input", msg => {
        try {
          const result = validate(contract, before, msg);
          assert.equal(result.ok, true, result.violations.join("; "));
          assert.equal(msg.redclaw_trust.failure, 1);
          assert.equal(msg.redclaw_trust.trustScore, 0.333);
          assert.equal(msg.correlationId, "trust-correlation");
          assert.match(msg.payload, /tool unavailable/);
          alerted = true;
          finish();
        } catch (error) {
          done(error);
        }
      });

      node.receive(input);
    });
  });
});
