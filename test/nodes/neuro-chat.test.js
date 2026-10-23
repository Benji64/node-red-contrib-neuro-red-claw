/**
 * Vérifie la séparation stricte CHAT (réactif) / ASSISTANCE (proactif)
 * introduite en v2.13 — le point critique est qu'un message proactif
 * ne doit JAMAIS apparaître dans le flux chat, et inversement.
 */
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const helper = require("node-red-node-test-helper");
const neuroChat = require("../../nodes/neuro-chat.js");

helper.init(require.resolve("node-red"));

describe("neuro-chat", () => {
  afterEach(() => helper.unload());

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
    };
    neuroChat(RED);
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
    for (const key of ["skillTarget", "maxHistory", "uiTitle", "assistTitle"]) {
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
    assert.equal(node.skillTarget, "");
    assert.equal(node.maxHistory, 50);
    assert.equal(node.uiTitle, "neuro-red-claw Chat");
    assert.equal(node.assistTitle, "Assistance");
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
    assert.equal(node.skillTarget, "");
    assert.equal(node.maxHistory, 50);
  });

  it("defaults malformed settings and preserves valid display settings", () => {
    const { node, warnings } = instantiateNode({
      skillTarget: {},
      maxHistory: "0",
      uiTitle: {},
      assistTitle: "",
    });

    assert.equal(node.skillTarget, "");
    assert.equal(node.maxHistory, 50);
    assert.equal(node.uiTitle, "neuro-red-claw Chat");
    assert.equal(node.assistTitle, "Assistance");
    assert.equal(warnings.length, 3);
  });

  it("accepts valid settings and positive integer strings", () => {
    const { node, warnings } = instantiateNode({
      skillTarget: "  energie  ",
      maxHistory: "25",
      uiTitle: "Chat énergie",
      assistTitle: "Aide",
    });

    assert.equal(node.skillTarget, "energie");
    assert.equal(node.maxHistory, 25);
    assert.equal(node.uiTitle, "Chat énergie");
    assert.equal(node.assistTitle, "Aide");
    assert.deepEqual(warnings, []);
  });

  it("message utilisateur → Output 1 (chat) + Output 2 (skill), jamais Output 4", (t, done) => {
    const flow = [
      { id: "n1", type: "neuro-chat", skillTarget: "energie",
        wires: [["out1"], ["out2"], ["out3"], ["out4"]] },
      { id: "out1", type: "helper" }, { id: "out2", type: "helper" },
      { id: "out3", type: "helper" }, { id: "out4", type: "helper" },
    ];
    helper.load(neuroChat, flow, () => {
      const n1 = helper.getNode("n1");
      helper.getNode("out4").on("input", () => done(new Error("ne doit jamais toucher Output 4 (assistance)")));
      helper.getNode("out2").on("input", (msg) => {
        assert.equal(msg.payload, "allume le salon");
        assert.equal(msg.topic, "energie");
      });
      helper.getNode("out1").on("input", (msg) => {
        assert.equal(msg.payload.type, "chat_update");
        assert.equal(msg.payload.conversations.length, 1);
        assert.equal(msg.payload.conversations[0].role, "user");
        done();
      });
      n1.receive({ topic: "user_input", payload: "allume le salon" });
    });
  });

  it("réponse LLM réactive → Output 1 + Output 3, jamais Output 4", (t, done) => {
    const flow = [
      { id: "n1", type: "neuro-chat", wires: [["out1"], ["out2"], ["out3"], ["out4"]] },
      { id: "out1", type: "helper" }, { id: "out2", type: "helper" },
      { id: "out3", type: "helper" }, { id: "out4", type: "helper" },
    ];
    helper.load(neuroChat, flow, () => {
      const n1 = helper.getNode("n1");
      helper.getNode("out4").on("input", () => done(new Error("ne doit jamais toucher Output 4")));
      helper.getNode("out3").on("input", (msg) => {
        assert.equal(msg.payload.length, 1);
        assert.equal(msg.payload[0].Rôle, "🤖 Agent");
      });
      helper.getNode("out1").on("input", (msg) => {
        assert.equal(msg.payload.conversations[0].role, "assistant");
        assert.equal(msg.payload.conversations[0].content, "La lumière est allumée.");
        done();
      });
      n1.receive({ payload: "La lumière est allumée.", redclaw: { success: true, skill: { name: "energie" } } });
    });
  });

  it("message proactif explicite → Output 4 uniquement, jamais dans le chat", (t, done) => {
    const flow = [
      { id: "n1", type: "neuro-chat", wires: [["out1"], ["out2"], ["out3"], ["out4"]] },
      { id: "out1", type: "helper" }, { id: "out2", type: "helper" },
      { id: "out3", type: "helper" }, { id: "out4", type: "helper" },
    ];
    helper.load(neuroChat, flow, () => {
      const n1 = helper.getNode("n1");
      helper.getNode("out1").on("input", () => done(new Error("ne doit jamais toucher Output 1 (chat)")));
      helper.getNode("out2").on("input", () => done(new Error("ne doit jamais toucher Output 2 (skill)")));
      helper.getNode("out3").on("input", () => done(new Error("ne doit jamais toucher Output 3 (historique chat)")));
      helper.getNode("out4").on("input", (msg) => {
        try {
          assert.equal(msg.payload.type, "assistance_update");
          assert.equal(msg.payload.items[0].content, "Objectif atteint : conso < 200kWh");
          assert.equal(msg.payload.items[0].source, "budget");
          assert.equal(msg.payload.items[0].category, "success");
          done();
        } catch (e) { done(e); }
      });
      n1.receive({
        payload: "Objectif atteint : conso < 200kWh",
        chat_kind: "proactive", chat_source: "budget", chat_category: "success",
      });
    });
  });

  it("auto-détection redclaw_goal_achieved → assistance sans chat_kind explicite", (t, done) => {
    const flow = [
      { id: "n1", type: "neuro-chat", wires: [["out1"], ["out2"], ["out3"], ["out4"]] },
      { id: "out1", type: "helper" }, { id: "out2", type: "helper" },
      { id: "out3", type: "helper" }, { id: "out4", type: "helper" },
    ];
    helper.load(neuroChat, flow, () => {
      const n1 = helper.getNode("n1");
      helper.getNode("out1").on("input", () => done(new Error("ne doit jamais toucher Output 1")));
      helper.getNode("out4").on("input", (msg) => {
        assert.equal(msg.payload.type, "assistance_update");
        done();
      });
      n1.receive({
        payload: "Conso sous la cible",
        redclaw_goal_achieved: true,
        redclaw_goal: { name: "budget-mensuel" },
      });
    });
  });

  it("les deux flux restent indépendants après plusieurs messages mélangés", (t, done) => {
    const flow = [
      { id: "n1", type: "neuro-chat", wires: [["out1"], ["out2"], ["out3"], ["out4"]] },
      { id: "out1", type: "helper" }, { id: "out2", type: "helper" },
      { id: "out3", type: "helper" }, { id: "out4", type: "helper" },
    ];
    helper.load(neuroChat, flow, () => {
      const n1 = helper.getNode("n1");
      let chatUpdates = 0, assistUpdates = 0;

      helper.getNode("out1").on("input", (msg) => {
        chatUpdates++;
        // Le flux chat ne doit JAMAIS contenir de contenu du flux assistance
        const contents = msg.payload.conversations.map(c => c.content);
        assert.ok(!contents.includes("insight de réflexion"));
      });
      helper.getNode("out4").on("input", (msg) => {
        assistUpdates++;
        if (assistUpdates === 2) {
          assert.equal(msg.payload.items.length, 2);
          assert.equal(chatUpdates, 2, "2 messages chat traités en parallèle des 2 assistance");
          done();
        }
      });

      n1.receive({ topic: "user_input", payload: "question 1" });
      n1.receive({ payload: "insight de réflexion", chat_kind: "proactive" });
      n1.receive({ payload: "réponse 1", redclaw: { success: true } });
      n1.receive({ payload: "autre insight", chat_kind: "proactive" });
    });
  });

  it("respecte son contrat cognitif (contracts/neuro-chat.yaml)", (t, done) => {
    const { loadContract, snapshot, validate } = require("../../lib/cognitive-contract");
    const contract = loadContract("neuro-chat");
    const flow = [
      { id: "n1", type: "neuro-chat", skillTarget: "energie",
        wires: [["out1"], ["out2"], ["out3"], ["out4"]] },
      { id: "out1", type: "helper" }, { id: "out2", type: "helper" },
      { id: "out3", type: "helper" }, { id: "out4", type: "helper" },
    ];
    helper.load(neuroChat, flow, () => {
      const n1 = helper.getNode("n1");
      const msgIn = { topic: "user_input", payload: "allume le salon" };
      const before = snapshot(msgIn);
      helper.getNode("out1").on("input", (msg) => {
        const result = validate(contract, before, msg);
        try { assert.equal(result.ok, true, result.violations.join("; ")); done(); }
        catch (e) { done(e); }
      });
      n1.receive(msgIn);
    });
  });
});
