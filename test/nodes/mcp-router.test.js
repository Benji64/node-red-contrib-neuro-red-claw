const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const helper = require("node-red-node-test-helper");
const mcpRouter = require("../../nodes/mcp-router.js");
const { loadContract, snapshot, validate } = require("../../lib/cognitive-contract");
const actionAuthority = require("../../lib/action-authority");

helper.init(require.resolve("node-red"));

function authorize(msg) {
  msg.redclaw_authorization = actionAuthority.issuePermit({
    tool: msg.redclaw.tool,
    params: msg.redclaw.params,
    sessionId: msg.sessionId || "default",
  });
  return msg;
}

function createRouter(config) {
  let RouterNode;
  const warnings = [];
  const RED = {
    nodes: {
      createNode(node) {
        const emitter = new EventEmitter();
        node.on = emitter.on.bind(emitter);
        node.emit = emitter.emit.bind(emitter);
        node.status = () => {};
        node.warn = warning => warnings.push(warning);
        node.error = () => {};
        node.send = () => {};
      },
      registerType(type, constructor) {
        if (type === "mcp-router") RouterNode = constructor;
      },
    },
  };
  mcpRouter(RED);
  const router = new RouterNode(config);
  router._testWarnings = warnings;
  return router;
}

describe("mcp-router", () => {
  afterEach(() => helper.unload());

  it("route vers la sortie numérotée correspondant au nom du tool", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-router", timeout: 500, debugMode: false,
        tools: [{ name: "turn_on" }, { name: "turn_off" }],
        wires: [["outOn"], ["outOff"], ["outRetour"]] },
      { id: "outOn", type: "helper" }, { id: "outOff", type: "helper" }, { id: "outRetour", type: "helper" },
    ];
    helper.load(mcpRouter, flow, () => {
      const n1 = helper.getNode("n1");
      const contract = loadContract("mcp-router");
      const input = authorize({
        redclaw: { tool: "turn_on", params: { device: "salon" } }, redclaw_call_id: "orig1",
      });
      const before = snapshot(input);
      helper.getNode("outOff").on("input", () => done(new Error("ne doit pas router vers turn_off")));
      helper.getNode("outOn").on("input", (msg) => {
        try {
          const result = validate(contract, before, msg);
          assert.equal(result.ok, true, result.violations.join("; "));
          assert.equal(msg.routeur.tool, "turn_on");
          assert.ok(msg.routeur.callId);
          done();
        } catch (e) { done(e); }
      });
      n1.receive(input);
    });
  });

  it("refuse explicitement un tool déclaré plusieurs fois", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-router", timeout: 500, debugMode: false,
        tools: [{ name: "turn_on" }, { name: "turn_on" }],
        wires: [["firstTool"], ["secondTool"], ["outRetour"]] },
      { id: "firstTool", type: "helper" },
      { id: "secondTool", type: "helper" },
      { id: "outRetour", type: "helper" },
    ];
    helper.load(mcpRouter, flow, () => {
      const router = helper.getNode("n1");
      helper.getNode("firstTool").on("input", () => done(new Error("ambiguous tool was dispatched")));
      helper.getNode("secondTool").on("input", () => done(new Error("ambiguous tool was dispatched")));
      helper.getNode("outRetour").on("input", msg => {
        try {
          assert.match(msg.redclaw_error, /Tool ambigu/);
          done();
        } catch (error) {
          done(error);
        }
      });
      router.receive(authorize({
        redclaw: { tool: "turn_on", params: {} },
        redclaw_call_id: "duplicate-tool",
      }));
    });
  });

  it("ignore une configuration tool avec getter sans perdre l'index des sorties", () => {
    const invalidTool = {};
    let getterInvoked = false;
    Object.defineProperty(invalidTool, "name", {
      enumerable: true,
      get() {
        getterInvoked = true;
        return "unsafe";
      },
    });
    const router = createRouter({
      tools: [invalidTool, { name: "turn_on" }],
      timeout: 500,
      debugMode: false,
    });
    assert.equal(getterInvoked, false);
    assert.equal(router._idx.get("turn_on"), 1);
    assert.equal(router._total, 3);
  });

  it("ne déclenche pas les accesseurs de configuration", () => {
    let getterInvoked = false;
    const config = { tools: [{ name: "turn_on" }] };
    for (const key of ["timeout", "debugMode"]) {
      Object.defineProperty(config, key, {
        enumerable: true,
        get() {
          getterInvoked = true;
          throw new Error(`${key} getter invoked`);
        },
      });
    }

    const router = createRouter(config);

    assert.equal(getterInvoked, false);
    assert.equal(router.timeout, 15000);
    assert.equal(router.debugMode, false);
    assert.equal(router._idx.get("turn_on"), 0);
    assert.equal(router._testWarnings.length, 2);
    router.emit("close");
  });

  it("ne déclenche pas les traps Proxy de configuration", () => {
    let trapInvoked = false;
    const config = new Proxy({}, {
      getOwnPropertyDescriptor() {
        trapInvoked = true;
        throw new Error("configuration Proxy trap invoked");
      },
    });

    const router = createRouter(config);

    assert.equal(trapInvoked, false);
    assert.equal(router._total, 1);
    assert.equal(router.timeout, 15000);
    assert.equal(router.debugMode, false);
    router.emit("close");
  });

  it("avertit sur les paramètres invalides et préserve les valeurs sûres explicites", () => {
    const router = createRouter({
      tools: [{ name: "turn_on" }],
      timeout: "10ms",
      debugMode: "true",
    });

    assert.equal(router.timeout, 15000);
    assert.equal(router.debugMode, false);
    assert.equal(router._testWarnings.length, 2);

    const configuredRouter = createRouter({
      tools: [{ name: "turn_on" }],
      timeout: "5000",
      debugMode: true,
    });
    assert.equal(configuredRouter.timeout, 5000);
    assert.equal(configuredRouter.debugMode, true);
    assert.deepEqual(configuredRouter._testWarnings, []);
    router.emit("close");
    configuredRouter.emit("close");
  });

  it("refuse les accesseurs sur les champs de sécurité sans les exécuter", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-router", timeout: 500, debugMode: false,
        tools: [{ name: "turn_on" }],
        wires: [["outTool"], ["outRetour"]] },
      { id: "outTool", type: "helper" }, { id: "outRetour", type: "helper" },
    ];
    helper.load(mcpRouter, flow, () => {
      const router = helper.getNode("n1");
      let getterInvoked = false;
      let errors = 0;
      router.error = (error, msg) => {
        errors++;
        try {
          assert.match(String(error), /Données de requête invalides/);
          if (errors === 2) done();
        } catch (assertionError) {
          done(assertionError);
        }
      };
      helper.getNode("outTool").on("input", () => done(new Error("invalid request reached a tool")));
      helper.getNode("outRetour").on("input", () => done(new Error("invalid request produced a result")));

      const redclaw = { params: {} };
      Object.defineProperty(redclaw, "tool", {
        enumerable: true,
        get() {
          getterInvoked = true;
          return "turn_on";
        },
      });
      router.receive({ redclaw, redclaw_call_id: "accessor-tool" });

      const callIdMessage = {
        redclaw: { tool: "turn_on", params: {} },
      };
      Object.defineProperty(callIdMessage, "redclaw_call_id", {
        enumerable: true,
        get() {
          getterInvoked = true;
          return "accessor-call-id";
        },
      });
      router.receive(callIdMessage);
      assert.equal(getterInvoked, false);
    });
  });

  it("refuse les accesseurs racine avant de tracer ou router le message", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-router", timeout: 500, debugMode: false,
        tools: [{ name: "turn_on" }],
        wires: [["outTool"], ["outRetour"]] },
      { id: "outTool", type: "helper" }, { id: "outRetour", type: "helper" },
    ];
    helper.load(mcpRouter, flow, () => {
      const router = helper.getNode("n1");
      let getterInvoked = false;
      helper.getNode("outTool").on("input", () => done(new Error("message with accessor was routed")));
      helper.getNode("outRetour").on("input", () => done(new Error("message with accessor produced a result")));
      router.error = error => {
        try {
          assert.match(String(error), /propriétés racine ne doivent pas être des accesseurs/);
          assert.equal(getterInvoked, false);
          done();
        } catch (assertionError) {
          done(assertionError);
        }
      };

      const input = { redclaw: { tool: "turn_on", params: {} } };
      Object.defineProperty(input, "neuro", {
        enumerable: true,
        get() {
          getterInvoked = true;
          return {};
        },
      });
      router.receive(input);
    });
  });

  it("refuse aussi les accesseurs racine symboliques avant de consommer l'autorisation", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-router", timeout: 500, debugMode: false,
        tools: [{ name: "turn_on" }],
        wires: [["outTool"], ["outRetour"]] },
      { id: "outTool", type: "helper" }, { id: "outRetour", type: "helper" },
    ];
    helper.load(mcpRouter, flow, () => {
      const router = helper.getNode("n1");
      const symbol = Symbol("unsafe");
      let getterInvoked = false;
      let sent = false;
      const input = authorize({
        redclaw: { tool: "turn_on", params: {} },
        redclaw_call_id: "symbol-accessor",
      });
      Object.defineProperty(input, symbol, {
        enumerable: true,
        get() {
          getterInvoked = true;
          return "unsafe";
        },
      });
      router.error = error => {
        try {
          assert.match(String(error), /propriétés racine ne doivent pas être des accesseurs/);
          assert.equal(getterInvoked, false);
          assert.equal(sent, false);
          done();
        } catch (assertionError) {
          done(assertionError);
        }
      };
      router.send = () => { sent = true; };
      router._inputCallback.call(router, input, outputs => router.send(outputs), error => {
        if (error) done(error);
      });
    });
  });

  it("refuse un message Proxy sans exécuter ses traps", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-router", timeout: 500, debugMode: false,
        tools: [{ name: "turn_on" }],
        wires: [["outTool"], ["outRetour"]] },
      { id: "outTool", type: "helper" }, { id: "outRetour", type: "helper" },
    ];
    helper.load(mcpRouter, flow, () => {
      const router = helper.getNode("n1");
      let trapInvoked = false;
      router.error = error => {
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
      router._inputCallback.call(router, input, () => {
        done(new Error("un message Proxy ne doit pas être routé"));
      }, error => {
        if (error) done(error);
      });
    });
  });

  it("refuse les métadonnées neuro Proxy avant le traçage", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-router", timeout: 500, debugMode: false,
        tools: [{ name: "turn_on" }],
        wires: [["outTool"], ["outRetour"]] },
      { id: "outTool", type: "helper" }, { id: "outRetour", type: "helper" },
    ];
    helper.load(mcpRouter, flow, () => {
      const router = helper.getNode("n1");
      let trapInvoked = false;
      router.error = error => {
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
      router._inputCallback.call(router, { neuro }, () => {
        done(new Error("les métadonnées neuro Proxy ne doivent pas être routées"));
      }, error => {
        if (error) done(error);
      });
    });
  });

  it("refuse un objet redclaw Proxy sans exécuter ses traps", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-router", timeout: 500, debugMode: false,
        tools: [{ name: "turn_on" }],
        wires: [["outTool"], ["outRetour"]] },
      { id: "outTool", type: "helper" }, { id: "outRetour", type: "helper" },
    ];
    helper.load(mcpRouter, flow, () => {
      const router = helper.getNode("n1");
      let trapInvoked = false;
      router.error = error => {
        try {
          assert.match(String(error), /Données de requête invalides/);
          assert.equal(trapInvoked, false);
          done();
        } catch (assertionError) {
          done(assertionError);
        }
      };
      const redclaw = new Proxy({}, {
        getOwnPropertyDescriptor() {
          trapInvoked = true;
          throw new Error("descriptor trap invoked");
        },
      });
      router._inputCallback.call(router, {
        redclaw,
        redclaw_call_id: "redclaw-proxy",
      }, () => {
        done(new Error("un redclaw Proxy ne doit pas être routé"));
      }, error => {
        if (error) done(error);
      });
    });
  });

  it("résout et retourne le résultat sur la sortie ⚡ avec le callId original", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-router", timeout: 500, debugMode: false,
        tools: [{ name: "turn_on" }],
        wires: [["outOn"], ["outRetour"]] },
      { id: "outOn", type: "helper" }, { id: "outRetour", type: "helper" },
    ];
    helper.load(mcpRouter, flow, () => {
      const n1 = helper.getNode("n1");
      const contract = loadContract("mcp-router");
      const input = authorize({ redclaw: { tool: "turn_on", params: {} }, redclaw_call_id: "orig1" });
      const before = snapshot(input);
      helper.getNode("outOn").on("input", (msg) => {
        // Simule un adapter qui répond
        n1.receive({ adaptateur: { callId: msg.routeur.callId, success: true, state: "ON" } });
      });
      helper.getNode("outRetour").on("input", (msg) => {
        try {
          const result = validate(contract, before, msg);
          assert.equal(result.ok, true, result.violations.join("; "));
          assert.equal(msg.redclaw_call_id, "orig1", "doit renvoyer le callId ORIGINAL, pas l'interne");
          assert.equal(msg.payload.state, "ON");
          done();
        } catch (e) { done(e); }
      });
      n1.receive(input);
    });
  });

  it("ignore les retours sans callId fiable au lieu d'utiliser celui du message", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-router", timeout: 500, debugMode: false,
        tools: [{ name: "turn_on" }],
        wires: [["outOn"], ["outRetour"]] },
      { id: "outOn", type: "helper" }, { id: "outRetour", type: "helper" },
    ];
    helper.load(mcpRouter, flow, () => {
      const router = helper.getNode("n1");
      let getterInvoked = false;

      helper.getNode("outOn").on("input", msg => {
        router.receive({
          adaptateur: { success: false },
          redclaw_call_id: msg.routeur.callId,
        });

        const invalidResult = { success: false };
        Object.defineProperty(invalidResult, "callId", {
          enumerable: true,
          get() {
            getterInvoked = true;
            return "";
          },
        });
        router.receive({
          adaptateur: invalidResult,
          redclaw_call_id: msg.routeur.callId,
        });
        router.receive({
          adaptateur: { callId: msg.routeur.callId, success: true },
        });
      });
      helper.getNode("outRetour").on("input", msg => {
        try {
          assert.equal(getterInvoked, false, "le routeur ne doit pas exécuter l'accesseur callId");
          assert.equal(msg.payload.success, true, "seule la réponse portant le callId canonique doit résoudre l'appel");
          done();
        } catch (error) {
          done(error);
        }
      });

      router.receive(authorize({
        redclaw: { tool: "turn_on", params: {} },
        redclaw_call_id: "original-call",
      }));
    });
  });

  it("ignore les accesseurs dans le résultat adapter sans les exécuter", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-router", timeout: 500, debugMode: false,
        tools: [{ name: "turn_on" }],
        wires: [["outOn"], ["outRetour"]] },
      { id: "outOn", type: "helper" }, { id: "outRetour", type: "helper" },
    ];
    helper.load(mcpRouter, flow, () => {
      const router = helper.getNode("n1");
      let getterInvoked = false;

      helper.getNode("outOn").on("input", msg => {
        const invalidResult = { callId: msg.routeur.callId };
        Object.defineProperty(invalidResult, "success", {
          enumerable: true,
          get() {
            getterInvoked = true;
            return false;
          },
        });
        router.receive({ adaptateur: invalidResult });
        router.receive({
          adaptateur: { callId: msg.routeur.callId, success: true },
        });
      });
      helper.getNode("outRetour").on("input", msg => {
        try {
          assert.equal(getterInvoked, false, "la copie du résultat ne doit pas exécuter l'accesseur");
          assert.equal(msg.payload.success, true, "le résultat invalide ne doit pas résoudre l'appel");
          done();
        } catch (error) {
          done(error);
        }
      });

      router.receive(authorize({
        redclaw: { tool: "turn_on", params: {} },
        redclaw_call_id: "accessor-result",
      }));
    });
  });

  it("refuse un callId déjà en cours sans remplacer sa requête en attente", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-router", timeout: 500, debugMode: false,
        tools: [{ name: "turn_on" }],
        wires: [["outOn"], ["outRetour"]] },
      { id: "outOn", type: "helper" }, { id: "outRetour", type: "helper" },
    ];
    helper.load(mcpRouter, flow, () => {
      const router = helper.getNode("n1");
      let dispatchCount = 0;
      let duplicateRejected = false;
      let activeInternalCallId;

      helper.getNode("outOn").on("input", msg => {
        dispatchCount++;
        if (dispatchCount > 1) done(new Error("le callId dupliqué ne doit pas être dispatché"));
        activeInternalCallId = msg.routeur.callId;
      });
      helper.getNode("outRetour").on("input", msg => {
        try {
          if (msg.redclaw_security?.blocked) {
            assert.match(msg.redclaw_error, /Duplicate in-flight callId/);
            duplicateRejected = true;
            router.receive({
              adaptateur: { callId: activeInternalCallId, success: true },
            });
            return;
          }

          assert.equal(duplicateRejected, true);
          assert.equal(dispatchCount, 1);
          assert.equal(msg.payload.success, true);
          done();
        } catch (error) {
          done(error);
        }
      });

      router.receive(authorize({
        redclaw: { tool: "turn_on", params: { value: 1 } },
        redclaw_call_id: "shared-call",
      }));
      router.receive(authorize({
        redclaw: { tool: "turn_on", params: { value: 2 } },
        redclaw_call_id: "shared-call",
      }));
    });
  });

  it("une réponse tardive ne résout pas un nouvel appel réutilisant le même callId externe", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-router", timeout: 80, debugMode: false,
        tools: [{ name: "turn_on" }],
        wires: [["outOn"], ["outRetour"]] },
      { id: "outOn", type: "helper" }, { id: "outRetour", type: "helper" },
    ];
    helper.load(mcpRouter, flow, () => {
      const router = helper.getNode("n1");
      const internalCallIds = [];
      let timedOut = false;

      helper.getNode("outOn").on("input", msg => {
        internalCallIds.push(msg.routeur.callId);
        if (internalCallIds.length === 2) {
          try {
            assert.notEqual(internalCallIds[1], internalCallIds[0]);
            router.receive({
              adaptateur: { callId: internalCallIds[0], success: false, result: "stale" },
            });
            router.receive({
              adaptateur: { callId: internalCallIds[1], success: true, result: "current" },
            });
          } catch (error) {
            done(error);
          }
        }
      });
      helper.getNode("outRetour").on("input", msg => {
        try {
          if (msg.redclaw_error) {
            assert.equal(msg.redclaw_call_id, "reusable-id");
            timedOut = true;
            router.receive(authorize({
              redclaw: { tool: "turn_on", params: { value: 2 } },
              redclaw_call_id: "reusable-id",
            }));
            return;
          }

          assert.equal(timedOut, true);
          assert.equal(msg.redclaw_call_id, "reusable-id");
          assert.equal(msg.payload.result, "current");
          done();
        } catch (error) {
          done(error);
        }
      });

      router.receive(authorize({
        redclaw: { tool: "turn_on", params: { value: 1 } },
        redclaw_call_id: "reusable-id",
      }));
    });
  });

  it("route aussi les noms de tools hérités de Object.prototype", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-router", timeout: 500, debugMode: false,
        tools: [{ name: "__proto__" }],
        wires: [["outTool"], ["outRetour"]] },
      { id: "outTool", type: "helper" }, { id: "outRetour", type: "helper" },
    ];
    helper.load(mcpRouter, flow, () => {
      const router = helper.getNode("n1");
      const input = authorize({
        redclaw: { tool: "__proto__", params: { value: 1 } },
        redclaw_call_id: "prototype-tool",
      });
      const before = snapshot(input);
      const contract = loadContract("mcp-router");

      helper.getNode("outTool").on("input", msg => {
        try {
          const routed = validate(contract, before, msg);
          assert.equal(routed.ok, true, routed.violations.join("; "));
          assert.equal(msg.routeur.tool, "__proto__");
          router.receive({
            adaptateur: { callId: msg.routeur.callId, success: true },
          });
        } catch (error) {
          done(error);
        }
      });
      helper.getNode("outRetour").on("input", msg => {
        try {
          const returned = validate(contract, before, msg);
          assert.equal(returned.ok, true, returned.violations.join("; "));
          assert.equal(msg.redclaw_call_id, "prototype-tool");
          assert.equal(msg.payload.success, true);
          done();
        } catch (error) {
          done(error);
        }
      });

      router.receive(input);
    });
  });

  it("timeout : renvoie une erreur sur la sortie ⚡ si aucun adapter ne répond", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-router", timeout: 100, debugMode: false,
        tools: [{ name: "turn_on" }],
        wires: [["outOn"], ["outRetour"]] },
      { id: "outOn", type: "helper" }, { id: "outRetour", type: "helper" },
    ];
    helper.load(mcpRouter, flow, () => {
      const n1 = helper.getNode("n1");
      let dispatchAuthorization;
      let internalCallId;
      helper.getNode("outOn").on("input", msg => {
        dispatchAuthorization = msg.redclaw_dispatch_authorization;
        internalCallId = msg.routeur.callId;
      });
      helper.getNode("outRetour").on("input", (msg) => {
        try {
          assert.ok(msg.redclaw_error, "doit produire une erreur explicite au timeout");
          assert.equal(typeof dispatchAuthorization, "string");
          assert.equal(
            actionAuthority.inspectPermit(
              dispatchAuthorization,
              "turn_on",
              {},
              "default",
              "dispatch",
              internalCallId,
            ).allowed,
            false,
            "le ticket de dispatch doit être révoqué après expiration",
          );
          done();
        } catch (e) { done(e); }
      });
      n1.receive(authorize({ redclaw: { tool: "turn_on", params: {} }, redclaw_call_id: "orig1" }));
    });
  });

  it("ne produit pas de sortie tardive quand il est fermé pendant un dispatch", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-router", timeout: 500, debugMode: false,
        tools: [{ name: "turn_on" }],
        wires: [["outOn"], ["outRetour"]] },
      { id: "outOn", type: "helper" }, { id: "outRetour", type: "helper" },
    ];
    helper.load(mcpRouter, flow, () => {
      const router = helper.getNode("n1");
      let dispatchAuthorization;
      let internalCallId;
      let returned = false;
      helper.getNode("outOn").on("input", msg => {
        dispatchAuthorization = msg.redclaw_dispatch_authorization;
        internalCallId = msg.routeur.callId;
        router.close();
        setImmediate(() => {
          try {
            assert.equal(returned, false, "aucune réponse ne doit être émise après fermeture");
            assert.equal(
              actionAuthority.inspectPermit(
                dispatchAuthorization,
                "turn_on",
                {},
                "default",
                "dispatch",
                internalCallId,
              ).allowed,
              false,
              "le ticket du dispatch en attente doit être révoqué à la fermeture",
            );
            done();
          } catch (error) {
            done(error);
          }
        });
      });
      helper.getNode("outRetour").on("input", () => { returned = true; });
      router.receive(authorize({
        redclaw: { tool: "turn_on", params: {} },
        redclaw_call_id: "close-in-flight",
      }));
    });
  });

  it("tool inconnu (non câblé) : erreur explicite, pas de blocage silencieux", (t, done) => {
    const flow = [
      { id: "n1", type: "mcp-router", timeout: 500, debugMode: false,
        tools: [{ name: "turn_on" }],
        wires: [["outOn"], ["outRetour"]] },
      { id: "outOn", type: "helper" }, { id: "outRetour", type: "helper" },
    ];
    helper.load(mcpRouter, flow, () => {
      const n1 = helper.getNode("n1");
      helper.getNode("outRetour").on("input", (msg) => {
        try {
          assert.match(msg.payload, /inconnu/i);
          done();
        } catch (e) { done(e); }
      });
      n1.receive(authorize({ redclaw: { tool: "tool_jamais_cable", params: {} }, redclaw_call_id: "x" }));
    });
  });
});
