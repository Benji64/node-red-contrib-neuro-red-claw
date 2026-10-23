const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const helper = require("node-red-node-test-helper");
const neuroContext = require("../../nodes/neuro-context.js");
const { loadContract, snapshot, validate } = require("../../lib/cognitive-contract");

helper.init(require.resolve("node-red"));

describe("neuro-context", () => {
  afterEach(() => helper.unload());

  function instantiateNode(config) {
    let registeredConstructor;
    const warnings = [];
    const RED = {
      nodes: {
        createNode(node) {
          node.id = "config-test";
        },
        getNode(id) {
          return id === "policy-1" ? { policies: [] } : null;
        },
        registerType(_name, constructor) {
          registeredConstructor = constructor;
        },
      },
    };
    neuroContext(RED);
    const node = new EventEmitter();
    node.status = () => {};
    node.warn = warning => warnings.push(warning);
    node.error = () => {};
    node.log = () => {};
    registeredConstructor.call(node, config);
    return { node, warnings };
  }

  it("does not invoke configuration accessors", () => {
    let getterInvoked = false;
    const config = {};
    for (const key of [
      "includeState", "includeTickets", "includeGoals", "includeConstraints",
      "ticketLimit", "skillFilter", "policyConfig",
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
    assert.equal(node.includeState, true);
    assert.equal(node.includeTickets, true);
    assert.equal(node.includeGoals, true);
    assert.equal(node.includeConstraints, true);
    assert.equal(node.ticketLimit, 5);
    assert.equal(node.skillFilter, "");
    assert.equal(node.policyConfig, null);
    assert.equal(warnings.length, 7);
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
    assert.equal(node.includeState, true);
    assert.equal(node.ticketLimit, 5);
    assert.equal(node.policyConfig, null);
  });

  it("defaults malformed options while preserving explicit valid values", () => {
    const { node, warnings } = instantiateNode({
      includeState: "false",
      includeTickets: false,
      includeGoals: true,
      includeConstraints: 0,
      ticketLimit: 21,
      skillFilter: {},
      policyConfig: {},
    });

    assert.equal(node.includeState, true);
    assert.equal(node.includeTickets, false);
    assert.equal(node.includeGoals, true);
    assert.equal(node.includeConstraints, true);
    assert.equal(node.ticketLimit, 5);
    assert.equal(node.skillFilter, "");
    assert.equal(node.policyConfig, null);
    assert.equal(warnings.length, 5);
  });

  it("resolves only a valid explicit policy reference", () => {
    const { node, warnings } = instantiateNode({
      includeState: false,
      includeTickets: false,
      includeGoals: false,
      includeConstraints: false,
      ticketLimit: "20",
      skillFilter: " energy ",
      policyConfig: "policy-1",
    });

    assert.equal(node.ticketLimit, 20);
    assert.equal(node.skillFilter, "energy");
    assert.deepEqual(node.policyConfig, { policies: [] });
    assert.deepEqual(warnings, []);
  });

  it("assembles and traces context, without discovering unreferenced policies", (t, done) => {
    const flow = [
      {
        id: "context",
        type: "neuro-context",
        includeState: false,
        includeTickets: false,
        includeGoals: true,
        includeConstraints: true,
        wires: [["out"], ["error"]],
      },
      { id: "out", type: "helper" },
      { id: "error", type: "helper" },
    ];

    helper.load(neuroContext, flow, () => {
      const node = helper.getNode("context");
      const contract = loadContract("neuro-context");
      const skillName = `context-test-${randomUUID()}`;
      const input = {
        payload: "inspect the energy system",
        sessionId: skillName,
        ora_perception: { observations: [{ source: "meter", key: "power", value: 12 }] },
      };
      const before = snapshot(input);

      helper.getNode("error").on("input", msg => done(new Error(msg.payload)));
      helper.getNode("out").on("input", msg => {
        try {
          const result = validate(contract, before, msg);
          assert.equal(result.ok, true, result.violations.join("; "));
          assert.equal(msg.neuro.context.state && Object.keys(msg.neuro.context.state).length, 0);
          assert.deepEqual(msg.neuro.context.tickets, []);
          assert.equal(msg.neuro.context.constraints, undefined);
          assert.equal(msg.context_summary, "");
          assert.equal(msg.sessionId, skillName);
          assert.equal(msg.ora_perception.observations[0].value, 12);
          assert.equal(msg.neuro.context.provenance.schemaVersion, 1);
          assert.equal(msg.neuro.context.provenance.scope, skillName);
          assert.match(
            msg.neuro.context.provenance.contextVersion,
            /^sha256:[a-f0-9]{64}$/,
          );
          assert.deepEqual(msg.neuro.context.provenance.sources, {
            goals: "goal-store",
          });
          assert.equal(msg.neuro.trace.at(-1).node, "context_engine");
          done();
        } catch (error) {
          done(error);
        }
      });

      node.receive(input);
    });
  });

  it("produces a stable context version for the same context data", (t, done) => {
    const flow = [
      {
        id: "context",
        type: "neuro-context",
        includeState: false,
        includeTickets: false,
        includeGoals: false,
        includeConstraints: false,
        wires: [["out"], ["error"]],
      },
      { id: "out", type: "helper" },
      { id: "error", type: "helper" },
    ];

    helper.load(neuroContext, flow, () => {
      const node = helper.getNode("context");
      const versions = [];
      helper.getNode("error").on("input", msg => done(new Error(msg.payload)));
      helper.getNode("out").on("input", msg => {
        try {
          versions.push(msg.neuro.context.provenance.contextVersion);
          if (versions.length === 1) {
            node.receive({ payload: "same request", sessionId: "same-scope" });
            return;
          }
          if (versions.length === 2) {
            assert.equal(versions[0], versions[1]);
            node.receive({ payload: "same request", sessionId: "other-scope" });
            return;
          }
          assert.notEqual(versions[1], versions[2]);
          done();
        } catch (error) {
          done(error);
        }
      });

      node.receive({ payload: "same request", sessionId: "same-scope" });
    });
  });

  it("defaults invalid imported ticket limits to the supported range", (t, done) => {
    const flow = [
      {
        id: "context",
        type: "neuro-context",
        ticketLimit: "21tickets",
        includeState: false,
        includeTickets: false,
        includeGoals: false,
        wires: [["out"], ["error"]],
      },
      { id: "out", type: "helper" },
      { id: "error", type: "helper" },
    ];

    helper.load(neuroContext, flow, () => {
      try {
        assert.equal(helper.getNode("context").ticketLimit, 5);
        done();
      } catch (error) {
        done(error);
      }
    });
  });
});
