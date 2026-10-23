const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const helper = require("node-red-node-test-helper");
const mcpAdapter = require("../../nodes/mcp-adapter.js");
const { loadContract, snapshot, validate } = require("../../lib/cognitive-contract");
const actionAuthority = require("../../lib/action-authority");

helper.init(require.resolve("node-red"));

function dispatch(routeur, sessionId = "default") {
  return actionAuthority.issuePermit({
    tool: routeur.tool,
    params: routeur.params,
    sessionId,
    kind: "dispatch",
    correlationId: routeur.callId,
  });
}

function startDispatch(adapter, tool, callId) {
  const routeur = { tool, params: {}, callId };
  adapter.receive({
    routeur,
    redclaw_dispatch_authorization: dispatch(routeur),
  });
}

describe("mcp-adapter", () => {
  afterEach(() => helper.unload());

  function createAdapter(config) {
    let AdapterNode;
    const warnings = [];
    const errors = [];
    const RED = {
      nodes: {
        createNode(node) {
          node.id = "config-test";
          node.status = () => {};
          node.warn = warning => warnings.push(warning);
          node.error = error => errors.push(error);
        },
        registerType(_type, constructor) {
          AdapterNode = constructor;
        },
      },
    };
    mcpAdapter(RED);
    const node = new EventEmitter();
    node.status = () => {};
    node.warn = warning => warnings.push(warning);
    node.error = error => errors.push(error);
    node.log = () => {};
    AdapterNode.call(node, config);
    return { node, warnings, errors };
  }

  it("does not invoke configuration accessors", () => {
    let getterInvoked = false;
    const config = {};
    for (const key of [
      "toolName", "timeout", "simpleMode", "debugMode",
      "inputTransform", "outputTransform", "validateResponse",
    ]) {
      Object.defineProperty(config, key, {
        enumerable: true,
        get() {
          getterInvoked = true;
          throw new Error(`${key} getter invoked`);
        },
      });
    }

    const { node } = createAdapter(config);

    assert.equal(getterInvoked, false);
    assert.equal(node.toolName, "");
    assert.equal(node.timeout, 15000);
    assert.equal(node.simpleMode, false);
    assert.equal(node.debugMode, false);
    assert.equal(node._configurationErrors.length, 7);
    node.emit("close");
  });

  it("does not invoke configuration Proxy traps and blocks dispatch", () => {
    let trapInvoked = false;
    const config = new Proxy({}, {
      getOwnPropertyDescriptor() {
        trapInvoked = true;
        throw new Error("configuration Proxy trap invoked");
      },
    });

    const { node } = createAdapter(config);

    assert.equal(trapInvoked, false);
    assert.equal(node._configurationErrors.includes("configuration must be a plain object"), true);
    node.emit("close");
  });

  it("warns and defaults malformed timeout and boolean options", () => {
    const { node, warnings } = createAdapter({
      toolName: "read",
      timeout: "15seconds",
      simpleMode: "true",
      debugMode: 1,
    });

    assert.equal(node.toolName, "read");
    assert.equal(node.timeout, 15000);
    assert.equal(node.simpleMode, false);
    assert.equal(node.debugMode, false);
    assert.equal(warnings.length, 3);
    node.emit("close");
  });

  it("preserves valid configuration and script compilation", () => {
    const { node, warnings } = createAdapter({
      toolName: " read ",
      timeout: "5000",
      simpleMode: true,
      debugMode: false,
      inputTransform: "return msg;",
      outputTransform: "adaptateur.success = true;",
      validateResponse: "return true;",
    });

    assert.equal(node.toolName, "read");
    assert.equal(node.timeout, 5000);
    assert.equal(node.simpleMode, true);
    assert.equal(node.debugMode, false);
    assert.equal(typeof node._inputFn, "function");
    assert.equal(typeof node._outputFn, "function");
    assert.equal(typeof node._validateFn, "function");
    assert.deepEqual(warnings, []);
    node.emit("close");
  });

  it("CAS 2→transform entrée→Output1, puis retour simulé→CAS1→Output2 avec callId propagé", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "turn_on", timeout: 500, debugMode: false,
        inputTransform: "msg.payload = { dps: 1, set: msg.payload.state === 'ON' }; return msg;",
        outputTransform: "adaptateur.success = true; adaptateur.state = msg.payload.dps === 1 ? 'ON' : 'OFF';",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const n1 = helper.getNode("n1");
      const contract = loadContract("mcp-adapter");
      const routeur = { tool: "turn_on", params: { state: "ON" }, callId: "cid1" };
      const input = {
        redclaw_call_id: "cid1",
        payload: { dps: { "1": true } },
        routeur,
        redclaw_dispatch_authorization: dispatch(routeur),
      };
      const before = snapshot(input);

      helper.getNode("outNode").on("input", (msg) => {
        try {
          // Vérifie ce que le "nœud cible" (ex: Tuya) recevrait réellement
          assert.deepEqual(msg.payload, { dps: 1, set: true });
          assert.equal(msg.redclaw_call_id, "cid1", "callId doit être propagé vers le nœud cible");
        } catch (e) { return done(e); }
        // Simule le nœud cible qui préserve msg et met à jour payload (bon comportement Node-RED)
        n1.receive({ ...msg, payload: { dps: 1, state: "confirmed" } });
      });

      helper.getNode("outRouter").on("input", (msg) => {
        try {
          const result = validate(contract, before, msg);
          assert.equal(result.ok, true, result.violations.join("; "));
          assert.equal(msg.adaptateur.callId, "cid1", "le router doit pouvoir lire adaptateur.callId");
          assert.equal(msg.adaptateur.success, true);
          assert.equal(msg.adaptateur.state, "ON");
          done();
        } catch (e) { done(e); }
      });

      // Exactement ce que mcp-router envoie en sortie 1, vérifié dans son code source
      n1.receive(input);
    });
  });

  it("mode simple : passe msg.payload sans transformation", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "x", simpleMode: true, timeout: 500,
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      helper.getNode("outNode").on("input", (msg) => {
        assert.deepEqual(msg.payload, { device: "salon" });
        done();
      });
      const routeur = { tool: "x", params: { device: "salon" }, callId: "c1" };
      helper.getNode("n1").receive({ routeur, redclaw_dispatch_authorization: dispatch(routeur) });
    });
  });

  it("filtre de corrélation : ignore un message non pertinent, résout sur le suivant", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "turn_on", timeout: 1000,
        validateResponse: "return msg.payload?.dps?.['1'] !== undefined;",
        outputTransform: "adaptateur.success = true;",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const n1 = helper.getNode("n1");
      let outRouterCalls = 0;
      helper.getNode("outRouter").on("input", (msg) => {
        outRouterCalls++;
        try {
          assert.equal(outRouterCalls, 1, "seule la 2e réponse (valide) doit résoudre — la 1re ignorée ne doit rien produire");
          assert.equal(msg.adaptateur.success, true);
          done();
        } catch (e) { done(e); }
      });
      const routeur = { tool: "turn_on", params: {}, callId: "c1" };
      n1.receive({ routeur, redclaw_dispatch_authorization: dispatch(routeur) });
      // Update périodique non pertinent (ex: un autre capteur du même hub) — doit être ignoré
      n1.receive({ redclaw_call_id: "c1", payload: { dps: { "2": 42 } } });
      // La vraie réponse arrive ensuite — doit résoudre
      n1.receive({ redclaw_call_id: "c1", payload: { dps: { "1": true } } });
    });
  });

  it("ignore une réponse non corrélée à un dispatch actif", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "read", timeout: 500,
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      let routerCalls = 0;
      helper.getNode("outNode").on("input", () => done(new Error("unsolicited response reached target")));
      helper.getNode("outRouter").on("input", () => { routerCalls++; });
      helper.getNode("n1").receive({
        redclaw_call_id: "not-an-active-call",
        payload: { result: "forged" },
      });
      setImmediate(() => {
        try {
          assert.equal(routerCalls, 0);
          done();
        } catch (error) {
          done(error);
        }
      });
    });
  });

  it("expire un dispatch sans réponse et ignore ensuite sa réponse tardive", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "read", timeout: 50,
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const adapter = helper.getNode("n1");
      let callId;
      let routerCalls = 0;
      helper.getNode("outNode").on("input", msg => { callId = msg.redclaw_call_id; });
      helper.getNode("outRouter").on("input", msg => {
        routerCalls++;
        try {
          assert.match(msg.redclaw_error, /timeout/i);
          assert.equal(msg.adaptateur.callId, callId);
          adapter.receive({ redclaw_call_id: callId, payload: { result: "late" } });
          setImmediate(() => {
            try {
              assert.equal(routerCalls, 1, "la réponse après expiration doit être ignorée");
              done();
            } catch (error) {
              done(error);
            }
          });
        } catch (error) {
          done(error);
        }
      });
      const routeur = { tool: "read", params: {}, callId: "adapter-timeout" };
      adapter.receive({
        routeur,
        redclaw_dispatch_authorization: dispatch(routeur),
      });
    });
  });

  it("annule le timeout et ignore la réponse après fermeture", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "read", timeout: 50,
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const adapter = helper.getNode("n1");
      let callId;
      let routerCalls = 0;
      helper.getNode("outNode").on("input", msg => { callId = msg.redclaw_call_id; });
      helper.getNode("outRouter").on("input", () => { routerCalls++; });
      const routeur = { tool: "read", params: {}, callId: "adapter-close" };
      adapter.receive({
        routeur,
        redclaw_dispatch_authorization: dispatch(routeur),
      });
      adapter.close();
      setTimeout(() => {
        try {
          adapter.receive({ redclaw_call_id: callId, payload: { result: "late" } });
          assert.equal(routerCalls, 0, "fermeture annule le timeout et bloque toute réponse tardive");
          done();
        } catch (error) {
          done(error);
        }
      }, 75);
    });
  });

  it("un inputTransform en erreur ne transmet pas l'action au nœud cible", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "write", inputTransform: "throw new Error('bad input');",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const routeur = { tool: "write", params: { value: 1 }, callId: "input-failure" };
      let targetCalled = false;
      helper.getNode("outNode").on("input", () => { targetCalled = true; });
      helper.getNode("outRouter").on("input", msg => {
        try {
          assert.equal(targetCalled, false);
          assert.equal(msg.adaptateur.callId, routeur.callId);
          assert.equal(msg.adaptateur.success, false);
          assert.match(msg.redclaw_error, /inputTransform failed: bad input/);
          done();
        } catch (error) {
          done(error);
        }
      });

      helper.getNode("n1").receive({
        routeur,
        payload: { value: 1 },
        redclaw_dispatch_authorization: dispatch(routeur),
      });
    });
  });

  it("un inputTransform qui retourne une valeur non-message bloque le dispatch", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "write", inputTransform: "return false;",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const routeur = { tool: "write", params: { value: 1 }, callId: "invalid-transform-result" };
      let targetCalled = false;
      helper.getNode("outNode").on("input", () => { targetCalled = true; });
      helper.getNode("outRouter").on("input", msg => {
        try {
          assert.equal(targetCalled, false);
          assert.equal(msg.adaptateur.success, false);
          assert.match(msg.redclaw_error, /inputTransform must return a message object/);
          done();
        } catch (error) {
          done(error);
        }
      });

      helper.getNode("n1").receive({
        routeur,
        payload: { value: 1 },
        redclaw_dispatch_authorization: dispatch(routeur),
      });
    });
  });

  it("refuse un message Proxy retourné par inputTransform sans examiner ses traps", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "write",
        inputTransform: "return new Proxy({}, { getOwnPropertyDescriptor() { msg.payload.trapInvoked = true; throw new Error('descriptor trap invoked'); }, getPrototypeOf() { msg.payload.trapInvoked = true; throw new Error('prototype trap invoked'); } });",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const routeur = { tool: "write", params: {}, callId: "proxy-transform-result" };
      helper.getNode("outNode").on("input", () => done(new Error("un message Proxy transformé ne doit pas être dispatché")));
      helper.getNode("outRouter").on("input", msg => {
        try {
          assert.equal(msg.adaptateur.callId, routeur.callId);
          assert.equal(msg.adaptateur.success, false);
          assert.match(msg.redclaw_error, /must not return a Proxy message/);
          assert.doesNotMatch(msg.redclaw_error, /trap invoked/);
          done();
        } catch (error) {
          done(error);
        }
      });
      helper.getNode("n1").receive({
        routeur,
        redclaw_dispatch_authorization: dispatch(routeur),
      });
    });
  });

  it("un inputTransform asynchrone bloque le dispatch sans transmettre de Promise", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "write",
        inputTransform: "return Promise.reject(new Error('async input'));",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const routeur = { tool: "write", params: { value: 1 }, callId: "async-input" };
      let targetCalled = false;
      helper.getNode("outNode").on("input", () => { targetCalled = true; });
      helper.getNode("outRouter").on("input", msg => {
        try {
          assert.equal(targetCalled, false);
          assert.equal(msg.adaptateur.success, false);
          assert.match(msg.redclaw_error, /inputTransform must be synchronous/);
          done();
        } catch (error) {
          done(error);
        }
      });

      helper.getNode("n1").receive({
        routeur,
        payload: { value: 1 },
        redclaw_dispatch_authorization: dispatch(routeur),
      });
    });
  });

  it("un inputTransform thenable personnalisé bloque le dispatch", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "write",
        inputTransform: "return { then() { msg.payload.thenInvoked = true; } };",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const routeur = { tool: "write", params: { value: 1 }, callId: "thenable-input" };
      let targetCalled = false;
      helper.getNode("outNode").on("input", () => { targetCalled = true; });
      helper.getNode("outRouter").on("input", msg => {
        try {
          assert.equal(targetCalled, false);
          assert.equal(msg.payload.thenInvoked, undefined, "le thenable personnalisé ne doit pas être assimilé");
          assert.equal(msg.adaptateur.success, false);
          assert.match(msg.redclaw_error, /inputTransform must be synchronous/);
          done();
        } catch (error) {
          done(error);
        }
      });

      helper.getNode("n1").receive({
        routeur,
        payload: { value: 1 },
        redclaw_dispatch_authorization: dispatch(routeur),
      });
    });
  });

  it("la détection d'un then getter ne l'exécute pas", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "write",
        inputTransform: "return Object.defineProperty({}, 'then', { get() { msg.payload.thenGetterInvoked = true; return () => {}; } });",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const routeur = { tool: "write", params: { value: 1 }, callId: "then-getter" };
      let targetCalled = false;
      helper.getNode("outNode").on("input", () => { targetCalled = true; });
      helper.getNode("outRouter").on("input", msg => {
        try {
          assert.equal(targetCalled, false);
          assert.equal(msg.payload.thenGetterInvoked, undefined, "le getter then ne doit pas être invoqué");
          assert.equal(msg.adaptateur.success, false);
          done();
        } catch (error) {
          done(error);
        }
      });

      helper.getNode("n1").receive({
        routeur,
        payload: { value: 1 },
        redclaw_dispatch_authorization: dispatch(routeur),
      });
    });
  });

  it("inputTransform ne peut pas remplacer les identifiants internes du dispatch", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "write",
        inputTransform: "msg.redclaw_call_id = 'spoof'; msg.routeur.callId = 'spoof'; msg.adaptateur.callId = 'spoof'; return msg;",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const routeur = { tool: "write", params: { value: 1 }, callId: "canonical-input-id" };
      helper.getNode("outNode").on("input", msg => {
        try {
          assert.equal(msg.redclaw_call_id, routeur.callId);
          assert.equal(msg.adaptateur.callId, routeur.callId);
          assert.equal(msg.routeur, undefined);
          done();
        } catch (error) {
          done(error);
        }
      });
      helper.getNode("n1").receive({
        routeur,
        redclaw_dispatch_authorization: dispatch(routeur),
      });
    });
  });

  it("copie un message gelé retourné par inputTransform avant de fixer la corrélation", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "write",
        inputTransform: "return Object.freeze({ payload: { accepted: true }, redclaw_call_id: 'spoof', adaptateur: Object.freeze({ callId: 'spoof' }) });",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const routeur = { tool: "write", params: { value: 1 }, callId: "frozen-transform-message" };
      helper.getNode("outNode").on("input", msg => {
        try {
          assert.deepEqual(msg.payload, { accepted: true });
          assert.equal(msg.redclaw_call_id, routeur.callId);
          assert.equal(msg.adaptateur.callId, routeur.callId);
          assert.equal(msg.routeur, undefined);
          done();
        } catch (error) {
          done(error);
        }
      });
      helper.getNode("n1").receive({
        routeur,
        redclaw_dispatch_authorization: dispatch(routeur),
      });
    });
  });

  it("refuse un message transformé contenant un accesseur sans l'exécuter", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "write",
        inputTransform: "const result = { payload: {} }; Object.defineProperty(result, 'redclaw_call_id', { enumerable: true, get() { throw new Error('getter invoked'); } }); return result;",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const routeur = { tool: "write", params: {}, callId: "accessor-transform-message" };
      let targetCalled = false;
      helper.getNode("outNode").on("input", () => { targetCalled = true; });
      helper.getNode("outRouter").on("input", msg => {
        try {
          assert.equal(targetCalled, false);
          assert.equal(msg.adaptateur.success, false);
          assert.match(msg.redclaw_error, /must not contain accessors/);
          assert.doesNotMatch(msg.redclaw_error, /getter invoked/);
          done();
        } catch (error) {
          done(error);
        }
      });
      helper.getNode("n1").receive({
        routeur,
        redclaw_dispatch_authorization: dispatch(routeur),
      });
    });
  });

  it("refuse un ticket de dispatch lié à un autre callId", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "write",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const routeur = { tool: "write", params: { value: 1 }, callId: "call-2" };
      let targetCalled = false;
      let routerCalled = false;
      const adapter = helper.getNode("n1");
      adapter.warn = message => {
        try {
          assert.match(message, /does not match its authorization/);
        } catch (error) {
          done(error);
        }
      };
      helper.getNode("outNode").on("input", () => { targetCalled = true; });
      helper.getNode("outRouter").on("input", () => { routerCalled = true; });
      helper.getNode("n1").receive({
        routeur,
        redclaw_dispatch_authorization: actionAuthority.issuePermit({
          tool: routeur.tool,
          params: routeur.params,
          sessionId: "default",
          kind: "dispatch",
          correlationId: "call-1",
        }),
      });
      setImmediate(() => {
        try {
          assert.equal(targetCalled, false);
          assert.equal(routerCalled, false, "un dispatch refusé ne doit pas produire une réponse corrélée");
          done();
        } catch (error) {
          done(error);
        }
      });
    });
  });

  it("refuse un champ routeur défini par getter sans exécuter le getter", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "read",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const adapter = helper.getNode("n1");
      const params = { value: 1 };
      let getterInvoked = false;
      let targetCalled = false;
      helper.getNode("outNode").on("input", () => { targetCalled = true; });
      adapter.error = () => {
        try {
          assert.equal(getterInvoked, false);
          assert.equal(targetCalled, false);
          done();
        } catch (error) {
          done(error);
        }
      };

      const routeur = { params, callId: "accessor-routeur" };
      Object.defineProperty(routeur, "tool", {
        enumerable: true,
        get() {
          getterInvoked = true;
          return "read";
        },
      });
      adapter.receive({
        routeur,
        redclaw_dispatch_authorization: actionAuthority.issuePermit({
          tool: "read",
          params,
          sessionId: "default",
          kind: "dispatch",
          correlationId: "accessor-routeur",
        }),
      });
    });
  });

  it("refuse les accesseurs racine avant de tracer ou dispatcher le message", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "read",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const adapter = helper.getNode("n1");
      let getterInvoked = false;
      helper.getNode("outNode").on("input", () => done(new Error("message with accessor was dispatched")));
      helper.getNode("outRouter").on("input", () => done(new Error("message with accessor produced a result")));
      adapter.error = error => {
        try {
          assert.match(String(error), /propriétés racine ne doivent pas être des accesseurs/);
          assert.equal(getterInvoked, false);
          done();
        } catch (assertionError) {
          done(assertionError);
        }
      };

      const input = { routeur: { tool: "read", params: {}, callId: "root-accessor" } };
      Object.defineProperty(input, "neuro", {
        enumerable: true,
        get() {
          getterInvoked = true;
          return {};
        },
      });
      adapter.receive(input);
    });
  });

  it("refuse aussi les accesseurs racine symboliques avant le dispatch", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "read",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const adapter = helper.getNode("n1");
      const routeur = { tool: "read", params: {}, callId: "symbol-accessor" };
      const symbol = Symbol("unsafe");
      let getterInvoked = false;
      let sent = false;
      const input = {
        routeur,
        redclaw_dispatch_authorization: dispatch(routeur),
      };
      Object.defineProperty(input, symbol, {
        enumerable: true,
        get() {
          getterInvoked = true;
          return "unsafe";
        },
      });
      adapter.error = error => {
        try {
          assert.match(String(error), /propriétés racine ne doivent pas être des accesseurs/);
          assert.equal(getterInvoked, false);
          assert.equal(sent, false);
          done();
        } catch (assertionError) {
          done(assertionError);
        }
      };
      adapter.send = () => { sent = true; };
      adapter._inputCallback.call(adapter, input, outputs => adapter.send(outputs), error => {
        if (error) done(error);
      });
    });
  });

  it("refuse un message Proxy sans exécuter ses traps", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "read",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const adapter = helper.getNode("n1");
      let trapInvoked = false;
      adapter.error = error => {
        try {
          assert.match(String(error), /Message Proxy refusé avant inspection/);
          assert.equal(trapInvoked, false);
          done();
        } catch (assertionError) {
          done(assertionError);
        }
      };
      const input = new Proxy({}, {
        ownKeys() {
          trapInvoked = true;
          throw new Error("ownKeys trap invoked");
        },
      });
      adapter._inputCallback.call(adapter, input, () => {
        done(new Error("un message Proxy ne doit pas être dispatché"));
      }, error => {
        if (error) done(error);
      });
    });
  });

  it("refuse les métadonnées neuro Proxy avant le traçage", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "read",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const adapter = helper.getNode("n1");
      let trapInvoked = false;
      adapter.error = error => {
        try {
          assert.match(String(error), /Métadonnées neuro Proxy refusées/);
          assert.equal(trapInvoked, false);
          done();
        } catch (assertionError) {
          done(assertionError);
        }
      };
      const neuro = new Proxy({}, {
        get() {
          trapInvoked = true;
          throw new Error("neuro getter trap invoked");
        },
      });
      adapter._inputCallback.call(adapter, { neuro }, () => {
        done(new Error("les métadonnées neuro Proxy ne doivent pas être dispatchées"));
      }, error => {
        if (error) done(error);
      });
    });
  });

  it("refuse un objet routeur Proxy sans exécuter ses traps", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "read",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const adapter = helper.getNode("n1");
      let trapInvoked = false;
      adapter.error = error => {
        try {
          assert.match(String(error), /données de dispatch invalides/);
          assert.equal(trapInvoked, false);
          done();
        } catch (assertionError) {
          done(assertionError);
        }
      };
      const routeur = new Proxy({}, {
        getOwnPropertyDescriptor() {
          trapInvoked = true;
          throw new Error("descriptor trap invoked");
        },
      });
      adapter._inputCallback.call(adapter, { routeur }, () => {
        done(new Error("un routeur Proxy ne doit pas être dispatché"));
      }, error => {
        if (error) done(error);
      });
    });
  });

  it("inputTransform ne peut pas muter les paramètres autorisés via routeur.params", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "write",
        inputTransform: "msg.routeur.params.device.state = 'OFF'; return msg;",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const routeur = {
        tool: "write",
        params: { device: { state: "ON" } },
        callId: "immutable-authorized-params",
      };
      helper.getNode("outNode").on("input", msg => {
        try {
          assert.deepEqual(msg.payload, { device: { state: "ON" } });
          assert.equal(routeur.params.device.state, "ON");
          done();
        } catch (error) {
          done(error);
        }
      });
      helper.getNode("n1").receive({
        routeur,
        redclaw_dispatch_authorization: dispatch(routeur),
      });
    });
  });

  it("un outputTransform en erreur retourne une erreur, jamais un succès de fallback", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "read", outputTransform: "throw new Error('bad output');",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      helper.getNode("outRouter").on("input", msg => {
        try {
          assert.equal(msg.adaptateur.callId, "output-failure");
          assert.equal(msg.adaptateur.success, false);
          assert.match(msg.redclaw_error, /outputTransform failed: bad output/);
          done();
        } catch (error) {
          done(error);
        }
      });

      const adapter = helper.getNode("n1");
      startDispatch(adapter, "read", "output-failure");
      adapter.receive({
        redclaw_call_id: "output-failure",
        payload: { value: "raw result" },
      });
    });
  });

  it("refuse un accesseur outputTransform sans l'exécuter ni produire un succès", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "read",
        outputTransform: "Object.defineProperty(adaptateur, 'success', { enumerable: true, get() { throw new Error('getter invoked'); } });",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      helper.getNode("outRouter").on("input", msg => {
        try {
          assert.equal(msg.adaptateur.callId, "output-accessor");
          assert.equal(msg.adaptateur.success, false);
          assert.match(msg.redclaw_error, /must not contain accessors/);
          assert.doesNotMatch(msg.redclaw_error, /getter invoked/);
          done();
        } catch (error) {
          done(error);
        }
      });

      const adapter = helper.getNode("n1");
      startDispatch(adapter, "read", "output-accessor");
      adapter.receive({
        redclaw_call_id: "output-accessor",
        payload: { value: "raw result" },
      });
    });
  });

  it("un outputTransform asynchrone ne produit jamais un succès de fallback", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "read",
        outputTransform: "return Promise.reject(new Error('async output'));",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      helper.getNode("outRouter").on("input", msg => {
        try {
          assert.equal(msg.adaptateur.callId, "async-output");
          assert.equal(msg.adaptateur.success, false);
          assert.match(msg.redclaw_error, /outputTransform must be synchronous/);
          done();
        } catch (error) {
          done(error);
        }
      });

      const adapter = helper.getNode("n1");
      startDispatch(adapter, "read", "async-output");
      adapter.receive({
        redclaw_call_id: "async-output",
        payload: { value: "raw result" },
      });
    });
  });

  it("outputTransform ne peut pas remplacer le callId canonique de la réponse", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "read",
        outputTransform: "msg.redclaw_call_id = 'spoof'; adaptateur.success = true;",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      helper.getNode("outRouter").on("input", msg => {
        try {
          assert.equal(msg.redclaw_call_id, "canonical-output-id");
          assert.equal(msg.adaptateur.callId, "canonical-output-id");
          assert.equal(msg.adaptateur.success, true);
          done();
        } catch (error) {
          done(error);
        }
      });

      const adapter = helper.getNode("n1");
      startDispatch(adapter, "read", "canonical-output-id");
      adapter.receive({
        redclaw_call_id: "canonical-output-id",
        payload: { value: "result" },
      });
    });
  });

  it("un validateResponse qui échoue ignore le message au lieu de l'accepter", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "read",
        validateResponse: "if (msg.payload.invalid) throw new Error('bad response'); return true;",
        outputTransform: "adaptateur.success = true; adaptateur.result = msg.payload.result;",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const adapter = helper.getNode("n1");
      let results = 0;
      helper.getNode("outRouter").on("input", msg => {
        results++;
        try {
          assert.equal(results, 1);
          assert.equal(msg.adaptateur.result, "valid");
          done();
        } catch (error) {
          done(error);
        }
      });

      startDispatch(adapter, "read", "response-validation");
      adapter.receive({ redclaw_call_id: "response-validation", payload: { invalid: true } });
      adapter.receive({ redclaw_call_id: "response-validation", payload: { result: "valid" } });
    });
  });

  it("un validateResponse asynchrone ignore le message sans validation fiable", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "read",
        validateResponse: "if (msg.payload.async) return Promise.reject(new Error('async validation')); return true;",
        outputTransform: "adaptateur.success = true; adaptateur.result = msg.payload.result;",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const adapter = helper.getNode("n1");
      let results = 0;
      helper.getNode("outRouter").on("input", msg => {
        results++;
        try {
          assert.equal(results, 1);
          assert.equal(msg.adaptateur.result, "valid");
          done();
        } catch (error) {
          done(error);
        }
      });

      startDispatch(adapter, "read", "async-validation");
      adapter.receive({
        redclaw_call_id: "async-validation",
        payload: { async: true },
      });
      adapter.receive({
        redclaw_call_id: "async-validation",
        payload: { result: "valid" },
      });
    });
  });

  it("un script invalide à la compilation bloque le dispatch", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "write", inputTransform: "return (",
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const routeur = { tool: "write", params: { value: 1 }, callId: "compile-failure" };
      let targetCalled = false;
      helper.getNode("outNode").on("input", () => { targetCalled = true; });
      helper.getNode("outRouter").on("input", msg => {
        try {
          assert.equal(targetCalled, false);
          assert.equal(msg.adaptateur.success, false);
          assert.match(msg.redclaw_error, /Invalid adapter configuration/);
          done();
        } catch (error) {
          done(error);
        }
      });

      helper.getNode("n1").receive({
        routeur,
        redclaw_dispatch_authorization: dispatch(routeur),
      });
    });
  });

  it("une configuration non textuelle du script bloque explicitement le dispatch", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: "write", inputTransform: { code: "return msg;" },
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const routeur = { tool: "write", params: { value: 1 }, callId: "invalid-config-type" };
      let targetCalled = false;
      helper.getNode("outNode").on("input", () => { targetCalled = true; });
      helper.getNode("outRouter").on("input", msg => {
        try {
          assert.equal(targetCalled, false);
          assert.equal(msg.adaptateur.success, false);
          assert.match(msg.redclaw_error, /Invalid adapter configuration: inputTransform must be a string/);
          done();
        } catch (error) {
          done(error);
        }
      });
      helper.getNode("n1").receive({
        routeur,
        payload: { value: 1 },
        redclaw_dispatch_authorization: dispatch(routeur),
      });
    });
  });

  it("un toolName de configuration non textuel n'empêche pas le démarrage mais bloque l'action", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-adapter", toolName: { name: "write" },
        wires: [["outNode"], ["outRouter"]] },
      { id: "outNode", type: "helper" }, { id: "outRouter", type: "helper" },
    ];
    helper.load(mcpAdapter, flow, () => {
      const routeur = { tool: "write", params: { value: 1 }, callId: "invalid-tool-name" };
      let targetCalled = false;
      helper.getNode("outNode").on("input", () => { targetCalled = true; });
      helper.getNode("outRouter").on("input", msg => {
        try {
          assert.equal(targetCalled, false);
          assert.equal(msg.adaptateur.success, false);
          assert.match(msg.adaptateur.error, /tool or callId does not match/);
          done();
        } catch (error) {
          done(error);
        }
      });
      helper.getNode("n1").receive({
        routeur,
        payload: { value: 1 },
        redclaw_dispatch_authorization: dispatch(routeur),
      });
    });
  });
});
