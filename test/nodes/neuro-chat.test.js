/**
 * Vérifie la séparation stricte CHAT (réactif) / ASSISTANCE (proactif)
 * introduite en v2.13 — le point critique est qu'un message proactif
 * ne doit JAMAIS apparaître dans le flux chat, et inversement.
 */
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const helper = require("node-red-node-test-helper");
const neuroChat = require("../../nodes/neuro-chat.js");

helper.init(require.resolve("node-red"));

describe("neuro-chat", () => {
  afterEach(() => helper.unload());

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
});
