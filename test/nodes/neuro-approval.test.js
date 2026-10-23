/**
 * Première couverture de neuro-approval — gouvernance humaine : ce qui
 * s'exécute après approbation doit être EXACTEMENT ce qui a été mis en
 * file ; aucune demande ne doit disparaître sans réponse ; un timeout ou
 * un refus ne doit jamais exécuter.
 */
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const helper = require("node-red-node-test-helper");
const neuroApproval = require("../../nodes/neuro-approval.js");
const { loadContract, snapshot, validate } = require("../../lib/cognitive-contract");
const actionAuthority = require("../../lib/action-authority");

helper.init(require.resolve("node-red"));

function flowWith(cfg) {
  return [
    { id: "n1", type: "neuro-approval", ...cfg, wires: [["dash"], ["approved"], ["rejected"]] },
    { id: "dash", type: "helper" }, { id: "approved", type: "helper" }, { id: "rejected", type: "helper" },
  ];
}
const action = (extra = {}) => {
  const message = {
    redclaw: { tool: "open_door", params: { door: "garage" } },
    redclaw_policy: { reason: "porte" },
    redclaw_call_id: "call-1",
    ...extra,
  };
  message.redclaw_authorization = actionAuthority.issuePermit({
    tool: message.redclaw.tool,
    params: message.redclaw.params,
    sessionId: message.sessionId || "default",
  });
  return message;
};

describe("neuro-approval", () => {
  afterEach(() => helper.unload());

  function instantiateNode(config) {
    let registeredConstructor;
    const warnings = [];
    const RED = {
      nodes: {
        createNode(node) {
          node.id = "config-test";
          node.type = "neuro-approval";
        },
        registerType(_name, constructor) {
          registeredConstructor = constructor;
        },
        getNode() {
          return null;
        },
        eachNode() {},
      },
      httpAdmin: { post() {} },
      auth: { needsPermission: () => () => {} },
      util: { cloneMessage: message => structuredClone(message) },
    };
    neuroApproval(RED);
    const node = new EventEmitter();
    node.id = "config-test";
    node.type = "neuro-approval";
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
    for (const key of ["timeout", "maxQueue", "autoReject", "requireAuthenticatedReviewer"]) {
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
    assert.equal(node.timeout, 300000);
    assert.equal(node.maxQueue, 20);
    assert.equal(node.autoReject, false);
    assert.equal(node.requireAuthenticatedReviewer, false);
    assert.equal(warnings.length, 4);
    node.emit("close");
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
    assert.equal(node.timeout, 300000);
    assert.equal(node.maxQueue, 20);
    node.emit("close");
  });

  it("defaults malformed options while preserving safe approval flags", () => {
    const { node, warnings } = instantiateNode({
      timeout: "10ms",
      maxQueue: "3items",
      autoReject: "true",
      requireAuthenticatedReviewer: 1,
    });

    assert.equal(node.timeout, 300000);
    assert.equal(node.maxQueue, 20);
    assert.equal(node.autoReject, false);
    assert.equal(node.requireAuthenticatedReviewer, false);
    assert.equal(warnings.length, 4);
    node.emit("close");
  });

  it("accepts valid bounds and explicit false and true flags", () => {
    const { node, warnings } = instantiateNode({
      timeout: "5000",
      maxQueue: "3",
      autoReject: true,
      requireAuthenticatedReviewer: true,
    });

    assert.equal(node.timeout, 5000);
    assert.equal(node.maxQueue, 3);
    assert.equal(node.autoReject, true);
    assert.equal(node.requireAuthenticatedReviewer, true);
    assert.deepEqual(warnings, []);
    node.emit("close");
  });

  it("defaults malformed or overflowing timeout and queue limits", (t, done) => {
    helper.load(neuroApproval, flowWith({ timeout: "10ms", maxQueue: "3items" }), () => {
      try {
        const node = helper.getNode("n1");
        assert.equal(node.timeout, 300000);
        assert.equal(node.maxQueue, 20);
        done();
      } catch (error) {
        done(error);
      }
    });
  });

  it("uses the authenticated Node-RED review route when strict reviewer mode is enabled", () => {
    let ApprovalNode;
    let route;
    let registeredNode;
    const sent = [];
    const RED = {
      nodes: {
        createNode(node, config) {
          Object.setPrototypeOf(node, EventEmitter.prototype);
          node.id = config.id;
          node.type = "neuro-approval";
          node.status = () => {};
          node.warn = () => {};
          node.error = error => { throw error; };
          node.send = outputs => sent.push(outputs);
          node.receive = message => node.emit("input", message);
          registeredNode = node;
        },
        registerType(type, constructor) {
          assert.equal(type, "neuro-approval");
          ApprovalNode = constructor;
        },
        getNode(id) {
          return id === registeredNode.id ? registeredNode : null;
        },
        eachNode() {},
      },
      httpAdmin: {
        post(path, permission, handler) {
          route = { path, permission, handler };
        },
      },
      auth: {
        needsPermission(permission) {
          return `permission:${permission}`;
        },
      },
      util: {
        cloneMessage(message) {
          return structuredClone(message);
        },
      },
    };
    neuroApproval(RED);
    const node = new ApprovalNode({
      id: "approval-1",
      requireAuthenticatedReviewer: true,
      timeout: 5000,
    });
    const original = action();
    node.receive(original);
    const [actionId] = node._queue.keys();

    node.receive({
      topic: "approve",
      payload: { actionId },
      decidedBy: "untrusted-dashboard",
    });
    assert.equal(node._queue.has(actionId), true);
    assert.equal(sent.some(outputs => outputs[1] !== null), false);

    const response = {
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    route.handler({
      params: { nodeId: "approval-1", actionId },
      body: { decision: "approve", reviewer: "forged-body-user" },
    }, response);
    assert.equal(response.statusCode, 401);
    assert.equal(node._queue.has(actionId), true);

    const approvedResponse = {
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    route.handler({
      user: { username: "authenticated-reviewer" },
      params: { nodeId: "approval-1", actionId },
      body: { decision: "approve", reviewer: "forged-body-user" },
    }, approvedResponse);

    assert.equal(route.path, "/redclaw/approvals/:nodeId/:actionId");
    assert.equal(route.permission, "permission:flows.write");
    assert.deepEqual(approvedResponse.body, {
      accepted: true,
      actionId,
      decision: "approve",
      reviewer: "authenticated-reviewer",
    });
    const result = sent.find(outputs => outputs[1] !== null);
    assert.equal(result[1].redclaw.tool, original.redclaw.tool);
    assert.equal(result[1].redclaw_authorization, original.redclaw_authorization);
    assert.equal(result[1].redclaw_approval.human_decision, "approved");
    assert.equal(result[1].redclaw_approval.human_decided_by, "authenticated-reviewer");
    const history = result[0].payload.history[0];
    assert.equal(history.decidedBy, "authenticated-reviewer");
    assert.equal(history.reviewerAuthenticated, true);
    assert.equal(history.human_required, true);
    assert.equal(history.human_decision, "approved");
    assert.equal(history.human_decided_at, history.approved_at);
    assert.equal(history.human_decided_by, "authenticated-reviewer");
    assert.equal(history.approved_by, "authenticated-reviewer");
    node.emit("close");
  });

  it("une demande est mise en file et publiée sur Output 1 avec son id", (t, done) => {
    helper.load(neuroApproval, flowWith({ timeout: 5000 }), () => {
      helper.getNode("dash").on("input", (msg) => {
        assert.equal(msg.payload.type, "approval_update");
        assert.equal(msg.payload.count, 1);
        assert.equal(msg.payload.queue[0].tool, "open_door");
        assert.ok(msg.payload.queue[0].id);
        done();
      });
      helper.getNode("n1").receive(action());
    });
  });

  it("approbation → Output 2 avec la demande d'origine ; un second approve est sans effet", (t, done) => {
    helper.load(neuroApproval, flowWith({ timeout: 5000 }), () => {
      const n1 = helper.getNode("n1");
      let id, executions = 0;
      helper.getNode("dash").on("input", (msg) => {
        if (!id) {
          id = msg.payload.queue[0].id;
          n1.receive({ topic: "approve", payload: { actionId: id } });
          n1.receive({ topic: "approve", payload: { actionId: id } }); // rejeu
        }
      });
      helper.getNode("approved").on("input", (msg) => {
        executions++;
        assert.equal(msg.redclaw.tool, "open_door");
        assert.equal(msg.redclaw_call_id, "call-1");
      });
      n1.receive(action());
      setTimeout(() => {
        try { assert.equal(executions, 1, "une approbation ne sert qu'une fois"); done(); }
        catch (e) { done(e); }
      }, 200);
    });
  });

  it("INTÉGRITÉ : ce qui s'exécute == ce qui a été mis en file, même si le dashboard mute son message", (t, done) => {
    helper.load(neuroApproval, flowWith({ timeout: 5000 }), () => {
      const n1 = helper.getNode("n1");
      helper.getNode("dash").on("input", (msg) => {
        const id = msg.payload.queue[0].id;
        // Un nœud en aval du dashboard altère ses données EN PLACE
        msg.redclaw.params.door = "TAMPERED";
        msg.payload.queue[0].params.door = "TAMPERED";
        n1.receive({ topic: "approve", payload: { actionId: id } });
      });
      helper.getNode("approved").on("input", (msg) => {
        try {
          assert.equal(msg.redclaw.params.door, "garage",
            "l'action exécutée doit être celle qui a été mise en file, pas la version altérée");
          done();
        } catch (e) { done(e); }
      });
      n1.receive(action());
    });
  });

  it("refus → Output 3, corrélé à la demande d'origine (redclaw_call_id conservé)", (t, done) => {
    helper.load(neuroApproval, flowWith({ timeout: 5000 }), () => {
      const n1 = helper.getNode("n1");
      helper.getNode("approved").on("input", () => done(new Error("un refus ne doit jamais exécuter")));
      helper.getNode("dash").on("input", (msg) => {
        if (msg.payload.queue.length) {
          n1.receive({ topic: "reject", payload: { actionId: msg.payload.queue[0].id }, decidedBy: "paulette" });
        }
      });
      helper.getNode("rejected").on("input", (msg) => {
        try {
          assert.match(msg.payload, /Refusé/);
          assert.equal(msg.redclaw_approval.decision, "reject");
          assert.equal(msg.redclaw_approval.decidedBy, "paulette");
          assert.equal(msg.redclaw_approval.human_required, true);
          assert.equal(msg.redclaw_approval.human_decision, "rejected");
          assert.equal(msg.redclaw_approval.approved_at, null);
          assert.equal(msg.redclaw_approval.approved_by, null);
          assert.equal(msg.redclaw_approval.human_decided_by, null);
          assert.equal(msg.redclaw_approval.reviewerAuthenticated, false);
          assert.equal(msg.redclaw_call_id, "call-1",
            "le demandeur doit pouvoir corréler le refus à sa demande");
          done();
        } catch (e) { done(e); }
      });
      n1.receive(action());
    });
  });

  it("actionId inconnu ou expiré → ignoré, rien n'est exécuté", (t, done) => {
    helper.load(neuroApproval, flowWith({ timeout: 5000 }), () => {
      for (const id of ["dash", "approved", "rejected"]) {
        helper.getNode(id).on("input", () => done(new Error("aucune sortie attendue")));
      }
      helper.getNode("n1").receive({ topic: "approve", payload: { actionId: "inconnu" } });
      setTimeout(done, 150);
    });
  });

  it("timeout + autoReject → Output 3, jamais exécuté, et approuver après expiration est sans effet", (t, done) => {
    helper.load(neuroApproval, flowWith({ timeout: 120, autoReject: true }), () => {
      const n1 = helper.getNode("n1");
      let id;
      helper.getNode("approved").on("input", () => done(new Error("un timeout ne doit JAMAIS approuver")));
      helper.getNode("dash").on("input", (msg) => { if (!id && msg.payload.queue.length) id = msg.payload.queue[0].id; });
      helper.getNode("rejected").on("input", (msg) => {
        try {
          assert.match(msg.payload, /Timeout/);
          assert.equal(msg.redclaw_call_id, "call-1");
        } catch (e) { return done(e); }
        n1.receive({ topic: "approve", payload: { actionId: id } }); // trop tard
        setTimeout(done, 120);
      });
      n1.receive(action());
    });
  });

  it("timeout sans autoReject → rien exécuté (fail-safe), tracé dans l'historique", (t, done) => {
    helper.load(neuroApproval, flowWith({ timeout: 100, autoReject: false }), () => {
      const n1 = helper.getNode("n1");
      helper.getNode("approved").on("input", () => done(new Error("ne doit jamais exécuter")));
      helper.getNode("rejected").on("input", () => done(new Error("sans autoReject, aucune sortie 3 attendue")));
      n1.receive(action());
      setTimeout(() => {
        // l'historique doit refléter l'expiration : visible via le prochain update
        helper.getNode("dash").on("input", (msg) => {
          try {
            assert.equal(msg.payload.history[0].decision, "timeout");
            done();
          } catch (e) { done(e); }
        });
        n1.receive(action({ redclaw_call_id: "call-2" }));
      }, 250);
    });
  });

  it("file pleine : l'action évincée reçoit une réponse terminale, jamais de disparition silencieuse", (t, done) => {
    helper.load(neuroApproval, flowWith({ timeout: 5000, maxQueue: 2 }), () => {
      const n1 = helper.getNode("n1");
      helper.getNode("approved").on("input", () => done(new Error("une éviction ne doit jamais exécuter")));
      helper.getNode("rejected").on("input", (msg) => {
        try {
          assert.match(msg.payload, /Évincé|file/i);
          assert.equal(msg.redclaw_call_id, "call-1", "c'est la PLUS ANCIENNE qui est évincée, et elle est notifiée");
          assert.equal(msg.redclaw_approval.decision, "evicted");
          done();
        } catch (e) { done(e); }
      });
      n1.receive(action({ redclaw_call_id: "call-1" }));
      n1.receive(action({ redclaw_call_id: "call-2" }));
      n1.receive(action({ redclaw_call_id: "call-3" })); // dépasse maxQueue=2
    });
  });

  it("le payload du dashboard reste sérialisable et n'expose aucun interne après une décision", (t, done) => {
    helper.load(neuroApproval, flowWith({ timeout: 5000 }), () => {
      const n1 = helper.getNode("n1");
      let step = 0;
      helper.getNode("dash").on("input", (msg) => {
        step++;
        try {
          const json = JSON.stringify(msg.payload); // lève sur une référence circulaire (Timeout)
          assert.doesNotMatch(json, /_timer|originalMsg/);
        } catch (e) { return done(e); }
        if (step === 1) n1.receive({ topic: "reject", payload: { actionId: msg.payload.queue[0].id } });
        if (step === 2) n1.receive(action({ redclaw_call_id: "call-2" })); // l'historique est maintenant non vide
        if (step === 3) done();
      });
      helper.getNode("rejected").on("input", () => {});
      n1.receive(action());
    });
  });

  it("respecte son contrat sur ses sorties (contracts/neuro-approval.yaml)", (t, done) => {
    const contract = loadContract("neuro-approval");
    helper.load(neuroApproval, flowWith({ timeout: 5000 }), () => {
      const n1 = helper.getNode("n1");
      const inAction = action();
      const before = snapshot(inAction);
      const results = {};
      const finish = () => {
        if (!(results.dash && results.approved)) return;
        try {
          for (const [k, r] of Object.entries(results)) assert.equal(r.ok, true, `${k}: ${r.violations.join("; ")}`);
          done();
        } catch (e) { done(e); }
      };
      let id;
      helper.getNode("dash").on("input", (msg) => {
        if (!id) { id = msg.payload.queue[0].id; results.dash = validate(contract, before, msg);
                   n1.receive({ topic: "approve", payload: { actionId: id } }); }
        finish();
      });
      helper.getNode("approved").on("input", (msg) => { results.approved = validate(contract, before, msg); finish(); });
      n1.receive(inAction);
    });
  });
});
