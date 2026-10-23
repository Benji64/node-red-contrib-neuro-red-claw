/**
 * Verrouille le bug corrigé en v2.6 : trace()/enrichContext()/setType()
 * mutaient msg.neuro en place. Comme mcp-router et mcp-adapter dupliquent
 * un message vers plusieurs sorties par simple {...msg} (shallow spread),
 * toutes les branches partageaient la même référence trace/context :
 * deux branches parallèles auraient vu leurs traces se mélanger.
 */
const test   = require("node:test");
const assert = require("node:assert/strict");
const NeuroMessage = require("../../lib/neuro-message");

test("deux branches issues d'un spread superficiel ont des trace[] distincts", () => {
  const source = { payload: "test" };
  NeuroMessage.wrap(source, { type: "event", source: "skill:energie" });
  NeuroMessage.trace(source, "mcp-router", "received");

  // Exactement ce que fait mcp-router/mcp-adapter en interne
  const branchA = { ...source, routeur: { tool: "turn_on" } };
  const branchB = { ...source, routeur: { tool: "turn_off" } };

  NeuroMessage.trace(branchA, "adapter:turn_on", "processing");
  NeuroMessage.trace(branchB, "adapter:turn_off", "processing");

  assert.notEqual(branchA.neuro.trace, branchB.neuro.trace, "les deux branches ne doivent pas partager le même array");
  assert.notEqual(branchA.neuro.trace, source.neuro.trace, "une branche ne doit pas polluer la source");
  assert.equal(NeuroMessage.traceSummary(branchA), "mcp-router → adapter:turn_on");
  assert.equal(NeuroMessage.traceSummary(branchB), "mcp-router → adapter:turn_off");
  assert.equal(NeuroMessage.traceSummary(source), "mcp-router", "la source ne doit garder que sa propre étape");
});

test("create refuse les Proxy et accesseurs dans ses options sans les exécuter", () => {
  let trapInvoked = false;
  const proxyOptions = new Proxy({}, {
    ownKeys() {
      trapInvoked = true;
      throw new Error("options proxy trap invoked");
    },
  });
  const getterOptions = {};
  Object.defineProperty(getterOptions, "type", {
    enumerable: true,
    get() {
      trapInvoked = true;
      throw new Error("options getter invoked");
    },
  });
  const contextWithGetter = {};
  Object.defineProperty(contextWithGetter, "state", {
    enumerable: true,
    get() {
      trapInvoked = true;
      throw new Error("context getter invoked");
    },
  });

  assert.throws(() => NeuroMessage.create(proxyOptions), TypeError);
  assert.throws(() => NeuroMessage.create(getterOptions), TypeError);
  assert.throws(() => NeuroMessage.create({ context: contextWithGetter }), TypeError);
  assert.equal(trapInvoked, false);
});

test("create détache le contexte et la trace tout en conservant les données métier", () => {
  const state = { temperature: 21 };
  const trace = [{ node: "source", ts: 1, action: "received" }];
  const data = { payload: { command: "run" } };
  const created = NeuroMessage.create({
    context: { state },
    trace,
    data,
  });
  state.temperature = 99;
  trace[0].node = "changed";

  assert.equal(created.context.state.temperature, 21);
  assert.equal(created.trace[0].node, "source");
  assert.equal(created.data, data);
});

test("create preserves explicitly supplied falsy business data", () => {
  for (const data of [false, 0, "", null, undefined]) {
    const created = NeuroMessage.create({ data });
    assert.equal(created.data, data);
  }
  assert.deepEqual(NeuroMessage.create().data, {});
});

test("wrap preserves explicitly supplied falsy business data", () => {
  for (const data of [false, 0, "", null, undefined]) {
    const msg = { payload: "fallback" };
    NeuroMessage.wrap(msg, { data });
    assert.equal(msg.neuro.data, data);
  }

  const fallback = { payload: "fallback" };
  NeuroMessage.wrap(fallback);
  assert.deepEqual(fallback.neuro.data, { payload: "fallback" });
});

test("wrap rejects an explicitly null priority", () => {
  assert.throws(() => NeuroMessage.wrap({ payload: "safe" }, { priority: null }), TypeError);
});

test("create refuse les traces qui ne sont pas directement traçables", () => {
  const invalidTraces = [
    ["unexpected"],
    [{ node: "source", metadata: { nested: true } }],
    [{ node: "source", value: undefined }],
  ];

  for (const trace of invalidTraces) {
    assert.throws(() => NeuroMessage.create({ trace }), TypeError);
  }

  const trace = [{ node: "source", ts: 1, action: "received" }];
  const created = NeuroMessage.create({ trace });
  assert.equal(NeuroMessage.canTrace(created), true);
});

test("create valide les types des champs de métadonnées", () => {
  const invalidOptions = [
    { type: { name: "event" } },
    { type: 0 },
    { source: 42 },
    { source: false },
    { intent: Symbol("intent") },
    { intent: 0 },
    { sessionId: 42 },
    { sessionId: 0 },
    { sessionId: null },
    { priority: null },
    { priority: "50" },
    { priority: NaN },
    { priority: Infinity },
    { priority: -1 },
    { priority: 101 },
  ];

  for (const options of invalidOptions) {
    assert.throws(() => NeuroMessage.create(options), TypeError);
  }

  const created = NeuroMessage.create({
    type: "event",
    source: "test",
    intent: "",
    sessionId: "session-1",
    priority: 100,
  });
  assert.equal(created.priority, 100);
  assert.equal(created.sessionId, "session-1");
});

test("create valide la forme des champs standardisés du contexte", () => {
  const invalidContexts = [
    { state: "temperature" },
    { state: [] },
    { memory: 42 },
    { tickets: {} },
    { goals: "goal" },
  ];

  for (const context of invalidContexts) {
    assert.throws(() => NeuroMessage.create({ context }), TypeError);
  }

  const created = NeuroMessage.create({ context: {} });
  assert.deepEqual(created.context, {
    state: {},
    memory: {},
    tickets: [],
    goals: [],
  });
  assert.deepEqual(NeuroMessage.create({ context: null }).context, {
    state: {},
    memory: {},
    tickets: [],
    goals: [],
  });

  for (const context of [false, 0, ""]) {
    assert.throws(() => NeuroMessage.create({ context }), TypeError);
  }
  for (const context of [
    { state: false },
    { memory: 0 },
    { tickets: "" },
    { goals: false },
  ]) {
    assert.throws(() => NeuroMessage.create({ context }), TypeError);
  }
});

test("create rejects invalid falsy trace values while keeping null as the empty default", () => {
  for (const trace of [false, 0, ""]) {
    assert.throws(() => NeuroMessage.create({ trace }), TypeError);
  }
  assert.deepEqual(NeuroMessage.create({ trace: null }).trace, []);
});

test("enrichContext ne mute pas le context d'une branche sœur", () => {
  const source = { payload: "x" };
  NeuroMessage.wrap(source, { type: "event", source: "hub" });
  NeuroMessage.enrichContext(source, { state: { temp: 21 } });

  const branchA = { ...source };
  const branchB = { ...source };
  NeuroMessage.enrichContext(branchA, { goals: ["reduce_energy"] });

  assert.deepEqual(branchB.neuro.context.state, { temp: 21 });
  // goals vaut [] par défaut (NeuroMessage.create) — le contrat à vérifier
  // est que branchB garde CE défaut intact, pas la valeur ajoutée sur branchA.
  assert.deepEqual(branchB.neuro.context.goals, [], "branchB ne doit pas voir l'enrichissement de branchA");
  assert.deepEqual(branchA.neuro.context.goals, ["reduce_energy"]);
});

test("wrap() ne réenveloppe pas un message déjà enveloppé", () => {
  const msg = { payload: "x" };
  NeuroMessage.wrap(msg, { type: "event" });
  const firstId = msg.neuro.id;
  NeuroMessage.wrap(msg, { type: "autre" });
  assert.equal(msg.neuro.id, firstId);
});

test("wrap refuse les Proxy et accesseurs sans les exécuter", () => {
  let trapInvoked = false;
  const proxyMessage = new Proxy({}, {
    getOwnPropertyDescriptor() {
      trapInvoked = true;
      throw new Error("message proxy trap invoked");
    },
  });
  const proxyOptions = new Proxy({}, {
    ownKeys() {
      trapInvoked = true;
      throw new Error("options proxy trap invoked");
    },
  });
  const getterMessage = {};
  Object.defineProperty(getterMessage, "payload", {
    enumerable: true,
    get() {
      trapInvoked = true;
      throw new Error("payload getter invoked");
    },
  });
  const getterOptions = {};
  Object.defineProperty(getterOptions, "type", {
    enumerable: true,
    get() {
      trapInvoked = true;
      throw new Error("type getter invoked");
    },
  });

  assert.throws(() => NeuroMessage.wrap(proxyMessage), TypeError);
  assert.throws(() => NeuroMessage.wrap({ payload: "safe" }, proxyOptions), TypeError);
  assert.throws(() => NeuroMessage.wrap(getterMessage), TypeError);
  assert.throws(() => NeuroMessage.wrap({ payload: "safe" }, getterOptions), TypeError);
  assert.equal(trapInvoked, false);
});

test("wrap conserve l'inférence de type et la référence du payload", () => {
  const payload = { command: "run" };
  const msg = {
    payload,
    redclaw: { tool: "run_command" },
    sessionId: "session-1",
  };

  NeuroMessage.wrap(msg);

  assert.equal(msg.neuro.type, NeuroMessage.TYPES.TOOL_CALL);
  assert.equal(msg.neuro.data.payload, payload);
  assert.equal(msg.neuro.sessionId, "session-1");
});

test("wrap rejects explicitly malformed source session IDs", () => {
  for (const sessionId of [false, 0, null]) {
    assert.throws(() => NeuroMessage.wrap({ payload: "safe", sessionId }), TypeError);
  }
  const absentSession = { payload: "safe" };
  NeuroMessage.wrap(absentSession);
  assert.equal(absentSession.neuro.sessionId, "");
});

test("wrap lets an explicit empty session ID override the input without reading it", () => {
  const msg = { payload: "safe" };
  Object.defineProperty(msg, "sessionId", {
    configurable: true,
    get() {
      throw new Error("sessionId getter invoked");
    },
  });

  assert.doesNotThrow(() => NeuroMessage.wrap(msg, { sessionId: "" }));
  assert.equal(msg.neuro.sessionId, "");
});

test("wrap rejects invalid falsy metadata options instead of replacing them with defaults", () => {
  for (const options of [
    { type: 0 },
    { source: false },
    { intent: 0 },
    { sessionId: null },
  ]) {
    assert.throws(() => NeuroMessage.wrap({ payload: "safe" }, options), TypeError);
  }
});

test("isValid distingue un message enveloppé d'un message brut", () => {
  assert.equal(NeuroMessage.isValid({ payload: "x" }), false);
  const wrapped = NeuroMessage.wrap({ payload: "x" }, { type: "event" });
  assert.equal(NeuroMessage.isValid(wrapped), true);
});

test("isValid rejette les Proxy et accesseurs sans les exécuter", () => {
  let trapInvoked = false;
  const neuroProxy = new Proxy({}, {
    getOwnPropertyDescriptor() {
      trapInvoked = true;
      throw new Error("neuro proxy trap invoked");
    },
  });
  const messageProxy = new Proxy({}, {
    getOwnPropertyDescriptor() {
      trapInvoked = true;
      throw new Error("message proxy trap invoked");
    },
  });
  const neuroWithGetter = {};
  Object.defineProperty(neuroWithGetter, "id", {
    enumerable: true,
    get() {
      trapInvoked = true;
      throw new Error("id getter invoked");
    },
  });

  assert.equal(NeuroMessage.isValid({ neuro: neuroProxy }), false);
  assert.equal(NeuroMessage.isValid(messageProxy), false);
  assert.equal(NeuroMessage.isValid({ neuro: neuroWithGetter }), false);
  assert.equal(trapInvoked, false);
});

test("isValid rejects accessor-backed extension metadata without invoking it", () => {
  let getterInvoked = false;
  const neuro = { id: "id", type: "event", ts: "timestamp" };
  Object.defineProperty(neuro, "extension", {
    enumerable: true,
    get() {
      getterInvoked = true;
      throw new Error("extension getter invoked");
    },
  });

  assert.equal(NeuroMessage.isValid({ neuro }), false);
  assert.equal(getterInvoked, false);
});

test("isValid n'accepte pas une validité héritée du prototype", () => {
  const neuro = Object.create({ id: "inherited", type: "event", ts: "then" });
  const msg = { neuro };

  assert.equal(NeuroMessage.isValid(msg), false);
});

test("isValid exige des identifiants, types et dates textuels non vides", () => {
  for (const invalidField of ["id", "type", "ts"]) {
    for (const value of [42, {}, ""]) {
      const neuro = { id: "id", type: "event", ts: "timestamp", [invalidField]: value };
      assert.equal(NeuroMessage.isValid({ neuro }), false);
    }
  }
  assert.equal(NeuroMessage.isValid({
    neuro: { id: "id", type: "event", ts: "not-validated-as-iso" },
  }), true);
});

test("isValid checks optional source, intent, and sessionId fields when present", () => {
  for (const field of ["source", "intent", "sessionId"]) {
    for (const value of [0, false, {}, []]) {
      assert.equal(NeuroMessage.isValid({
        neuro: {
          id: "id",
          type: "event",
          ts: "timestamp",
          [field]: value,
        },
      }), false, `${field} must reject ${typeof value}`);
    }
    assert.equal(NeuroMessage.isValid({
      neuro: {
        id: "id",
        type: "event",
        ts: "timestamp",
        [field]: "",
      },
    }), true, `${field} accepts an empty legacy string`);
  }

  assert.equal(NeuroMessage.isValid({
    neuro: { id: "id", type: "event", ts: "timestamp" },
  }), true);
});

test("isValid garde les enveloppes legacy sans contexte ni trace", () => {
  assert.equal(NeuroMessage.isValid({
    neuro: { id: "id", type: "event", ts: "timestamp" },
  }), true);
});

test("isValid refuse une trace présente mais non sûre", () => {
  let trapInvoked = false;
  const traceProxy = new Proxy([], {
    ownKeys() {
      trapInvoked = true;
      throw new Error("trace proxy trap invoked");
    },
  });
  const invalidTraces = [
    ["unexpected"],
    [{ node: "source", metadata: { nested: true } }],
    traceProxy,
  ];

  for (const trace of invalidTraces) {
    assert.equal(NeuroMessage.isValid({
      neuro: { id: "id", type: "event", ts: "timestamp", trace },
    }), false);
  }
  assert.equal(trapInvoked, false);
});

test("isValid refuse un contexte présent mais non sûr", () => {
  let trapInvoked = false;
  const contextProxy = new Proxy({}, {
    ownKeys() {
      trapInvoked = true;
      throw new Error("context proxy trap invoked");
    },
  });
  const contextWithGetter = {};
  Object.defineProperty(contextWithGetter, "state", {
    enumerable: true,
    get() {
      trapInvoked = true;
      throw new Error("context getter invoked");
    },
  });

  for (const context of [contextProxy, contextWithGetter, []]) {
    assert.equal(NeuroMessage.isValid({
      neuro: { id: "id", type: "event", ts: "timestamp", context },
    }), false);
  }
  assert.equal(trapInvoked, false);
});

test("isValid vérifie les formes des champs du contexte s'ils sont présents", () => {
  const invalidContexts = [
    { state: [] },
    { memory: "memory" },
    { tickets: {} },
    { goals: "goal" },
  ];

  for (const context of invalidContexts) {
    assert.equal(NeuroMessage.isValid({
      neuro: { id: "id", type: "event", ts: "timestamp", context },
    }), false);
  }
  assert.equal(NeuroMessage.isValid({
    neuro: { id: "id", type: "event", ts: "timestamp", context: {} },
  }), true);
});

test("isValid vérifie la priorité présente sans imposer ce champ aux messages legacy", () => {
  for (const priority of [-1, 101, NaN, Infinity, "50"]) {
    assert.equal(NeuroMessage.isValid({
      neuro: { id: "id", type: "event", ts: "timestamp", priority },
    }), false);
  }
  assert.equal(NeuroMessage.isValid({
    neuro: { id: "id", type: "event", ts: "timestamp", priority: 0 },
  }), true);
  assert.equal(NeuroMessage.isValid({
    neuro: { id: "id", type: "event", ts: "timestamp" },
  }), true);
});

test("clone isole profondément le contexte et la trace", () => {
  const msg = {
    payload: "source",
    neuro: {
      id: "source-id",
      type: "event",
      source: "test",
      context: { state: { temperature: 21 } },
      data: {},
      priority: 50,
      trace: [{ node: "source", ts: 1, action: "received" }],
    },
  };

  const cloned = NeuroMessage.clone(msg, {
    type: "skill_request",
    context: { goals: [{ name: "reduce_energy" }] },
  });
  cloned.neuro.context.state.temperature = 99;
  cloned.neuro.context.goals[0].name = "changed";
  cloned.neuro.trace[0].node = "changed";

  assert.equal(cloned.neuro.type, "skill_request");
  assert.equal(msg.neuro.context.state.temperature, 21);
  assert.equal(msg.neuro.context.goals, undefined);
  assert.equal(msg.neuro.trace[0].node, "source");
});

test("clone applies and detaches an explicit trace override", () => {
  const source = NeuroMessage.wrap({ payload: "source" });
  NeuroMessage.trace(source, "source", "received");
  const overrideTrace = [{ node: "replacement", ts: 2, action: "selected" }];

  const cloned = NeuroMessage.clone(source, { trace: overrideTrace });
  overrideTrace[0].node = "mutated";
  cloned.neuro.trace[0].action = "changed";

  assert.equal(cloned.neuro.trace.length, 1);
  assert.equal(cloned.neuro.trace[0].node, "replacement");
  assert.equal(source.neuro.trace[0].node, "source");
  assert.equal(NeuroMessage.traceSummary(cloned), "replacement");
});

test("clone rejects malformed explicit trace overrides", () => {
  const source = NeuroMessage.wrap({ payload: "source" });

  for (const trace of ["invalid", ["invalid"], [{ metadata: { nested: true } }]]) {
    assert.throws(() => NeuroMessage.clone(source, { trace }), TypeError);
  }
});

test("clone rejects invalid metadata overrides", () => {
  const invalidOverrides = [
    { type: {} },
    { source: 42 },
    { intent: false },
    { sessionId: null },
    { id: 0 },
    { id: "" },
    { id: undefined },
    { type: undefined },
    { ts: {} },
    { ts: "" },
    { ts: undefined },
    { priority: "50" },
    { priority: 101 },
    { priority: -1 },
  ];

  for (const overrides of invalidOverrides) {
    assert.throws(() => NeuroMessage.clone({ payload: "source" }, overrides), TypeError);
  }

  const cloned = NeuroMessage.clone({ payload: "source" }, {
    type: "event",
    source: "test",
    intent: "",
    sessionId: "",
    priority: 0,
  });
  assert.equal(cloned.neuro.type, "event");
  assert.equal(cloned.neuro.source, "test");
  assert.equal(cloned.neuro.priority, 0);
});

test("clone rejects malformed source metadata while preserving omitted legacy fields", () => {
  const invalidFields = [
    ["source", 0],
    ["intent", false],
    ["sessionId", {}],
    ["id", ""],
    ["id", undefined],
    ["type", 1],
    ["type", undefined],
    ["ts", null],
    ["ts", undefined],
    ["priority", Infinity],
  ];

  for (const [field, value] of invalidFields) {
    assert.throws(() => NeuroMessage.clone({
      neuro: { id: "id", type: "event", ts: "timestamp", [field]: value },
    }), TypeError, `${field} must be checked`);
  }

  const legacy = NeuroMessage.clone({ neuro: { id: "legacy-id" } });
  assert.equal(legacy.neuro.id, "legacy-id");
  assert.equal(Object.hasOwn(legacy.neuro, "type"), false);
  assert.equal(Object.hasOwn(legacy.neuro, "source"), false);
});

test("clone applies create defaults for explicitly empty type and source", () => {
  const msg = NeuroMessage.wrap({ payload: "source" });
  const cloned = NeuroMessage.clone(msg, { type: "", source: "" });

  assert.equal(cloned.neuro.type, "event");
  assert.equal(cloned.neuro.source, "unknown");
  assert.equal(NeuroMessage.isValid(cloned), true);
});

test("clone preserves non-enumerable neuro data properties", () => {
  const neuro = {
    type: "event",
    source: "test",
    ts: "timestamp",
    trace: [],
    context: {},
    priority: 50,
  };
  Object.defineProperty(neuro, "id", {
    value: "hidden-id",
    enumerable: false,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(neuro, "internalTag", {
    value: "preserved",
    enumerable: false,
    writable: true,
    configurable: true,
  });

  const cloned = NeuroMessage.clone({ neuro });

  assert.equal(cloned.neuro.id, "hidden-id");
  assert.equal(cloned.neuro.internalTag, "preserved");
  assert.equal(Object.getOwnPropertyDescriptor(cloned.neuro, "id").enumerable, false);
  assert.equal(Object.getOwnPropertyDescriptor(cloned.neuro, "internalTag").enumerable, false);
  assert.equal(NeuroMessage.isValid(cloned), true);
});

test("clone rejects non-enumerable neuro accessors without invoking them", () => {
  let getterInvoked = false;
  const neuro = { id: "source-id", type: "event", trace: [], context: {} };
  Object.defineProperty(neuro, "internalTag", {
    enumerable: false,
    get() {
      getterInvoked = true;
      throw new Error("hidden accessor invoked");
    },
  });

  assert.throws(() => NeuroMessage.clone({ neuro }), TypeError);
  assert.equal(getterInvoked, false);
});

test("clone enforces the canonical context field shapes after applying overrides", () => {
  const msg = NeuroMessage.wrap({ payload: "source" });
  for (const context of [
    { state: false },
    { memory: 0 },
    { tickets: {} },
    { goals: "goal" },
  ]) {
    assert.throws(() => NeuroMessage.clone(msg, { context }), TypeError);
  }

  const cloned = NeuroMessage.clone(msg, {
    context: { state: null, memory: null, tickets: null, goals: null },
  });
  assert.deepEqual(cloned.neuro.context, {
    state: {},
    memory: {},
    tickets: [],
    goals: [],
  });
  assert.equal(NeuroMessage.isValid(cloned), true);
});

test("clone refuse getters et Proxy sans exécuter leur code", () => {
  let trapInvoked = false;
  const getterMessage = {};
  Object.defineProperty(getterMessage, "payload", {
    enumerable: true,
    get() {
      trapInvoked = true;
      throw new Error("message getter invoked");
    },
  });
  const proxyOverrides = new Proxy({}, {
    ownKeys() {
      trapInvoked = true;
      throw new Error("override proxy trap invoked");
    },
  });

  assert.throws(() => NeuroMessage.clone(getterMessage), TypeError);
  assert.throws(() => NeuroMessage.clone({ payload: "safe" }, proxyOverrides), TypeError);
  assert.equal(trapInvoked, false);
});

test("clone defines neuro, trace, and context without invoking inherited setters", () => {
  const cases = [
    {
      property: "neuro",
      message: { payload: "source" },
      override: {},
    },
    {
      property: "trace",
      message: { neuro: { id: "source-id", trace: [], context: {} } },
      override: {},
    },
    {
      property: "context",
      message: { neuro: { id: "source-id", trace: [], context: {} } },
      override: {},
    },
  ];

  for (const { property, message, override } of cases) {
    const originalDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, property);
    let setterInvoked = false;
    let cloned;
    try {
      Object.defineProperty(Object.prototype, property, {
        configurable: true,
        set() {
          setterInvoked = true;
        },
      });
      cloned = NeuroMessage.clone(message, override);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(Object.prototype, property, originalDescriptor);
      } else {
        delete Object.prototype[property];
      }
    }

    assert.equal(setterInvoked, false, `${property} inherited setter must not be called`);
    if (property === "neuro") {
      assert.equal(Object.hasOwn(cloned, "neuro"), true);
    } else {
      assert.equal(Object.hasOwn(cloned.neuro, property), true);
    }
  }
});

test("clone refuse une trace JSON dont les entrées ne respectent pas le format", () => {
  const msg = {
    neuro: {
      id: "source-id",
      type: "event",
      trace: ["malformed-entry"],
      context: {},
    },
  };

  assert.throws(() => NeuroMessage.clone(msg), TypeError);
});

test("clone conserve le défaut historique de trace vide si absent", () => {
  const cloned = NeuroMessage.clone({ payload: "source", neuro: { id: "source-id" } });

  assert.deepEqual(cloned.neuro.trace, []);
  assert.notEqual(cloned.neuro.trace, undefined);
});

test("trace ignore les métadonnées neuro contenant un accesseur sans l'exécuter", () => {
  let getterInvoked = false;
  const neuro = { id: "existing", type: "event", source: "test", context: {}, data: {}, priority: 50 };
  Object.defineProperty(neuro, "trace", {
    enumerable: true,
    get() {
      getterInvoked = true;
      throw new Error("trace getter invoked");
    },
  });
  const msg = { neuro };

  assert.equal(NeuroMessage.canTrace(neuro), false);
  assert.equal(NeuroMessage.trace(msg, "test-node"), msg);
  assert.equal(getterInvoked, false);
});

test("trace ignore les métadonnées neuro Proxy sans exécuter ses traps", () => {
  let trapInvoked = false;
  const neuro = new Proxy({}, {
    getOwnPropertyDescriptor() {
      trapInvoked = true;
      throw new Error("neuro descriptor trap invoked");
    },
  });
  const msg = { neuro };

  assert.equal(NeuroMessage.canTrace(neuro), false);
  assert.equal(NeuroMessage.trace(msg, "test-node"), msg);
  assert.equal(trapInvoked, false);
});

test("trace n'évalue pas des accesseurs présents dans les entrées du tableau trace", () => {
  let getterInvoked = false;
  const trace = [];
  Object.defineProperty(trace, "0", {
    enumerable: true,
    get() {
      getterInvoked = true;
      throw new Error("trace entry getter invoked");
    },
  });
  const neuro = { id: "existing", type: "event", source: "test", context: {}, data: {}, priority: 50, trace };
  const msg = { neuro };

  assert.equal(NeuroMessage.canTrace(neuro), false);
  assert.equal(NeuroMessage.trace(msg, "test-node"), msg);
  assert.equal(getterInvoked, false);
});

test("trace refuse un tableau creux de longueur excessive sans le parcourir", () => {
  const trace = [];
  trace.length = 1_000_000_000;
  const neuro = {
    id: "existing",
    type: "event",
    source: "test",
    context: {},
    data: {},
    priority: 50,
    trace,
  };
  const msg = { neuro };

  assert.equal(NeuroMessage.canTrace(neuro), false);
  assert.equal(NeuroMessage.trace(msg, "test-node"), msg);
  assert.equal(msg.neuro.trace, trace);
  assert.equal(trace.length, 1_000_000_000);
});

test("trace refuse les propriétés supplémentaires atypiques dans le tableau", () => {
  const trace = [];
  trace.extra = "unexpected";
  const neuro = {
    id: "existing",
    type: "event",
    source: "test",
    context: {},
    data: {},
    priority: 50,
    trace,
  };
  const msg = { neuro };

  assert.equal(NeuroMessage.canTrace(neuro), false);
  assert.equal(NeuroMessage.trace(msg, "test-node"), msg);
  assert.equal(msg.neuro.trace, trace);
});

test("trace refuse les entrées Proxy sans exécuter leurs traps", () => {
  let trapInvoked = false;
  const entry = new Proxy({ node: "existing" }, {
    getOwnPropertyDescriptor() {
      trapInvoked = true;
      throw new Error("entry descriptor trap invoked");
    },
  });
  const neuro = {
    id: "existing",
    type: "event",
    source: "test",
    context: {},
    data: {},
    priority: 50,
    trace: [entry],
  };
  const msg = { neuro };

  assert.equal(NeuroMessage.canTrace(neuro), false);
  assert.equal(NeuroMessage.trace(msg, "test-node"), msg);
  assert.equal(NeuroMessage.traceSummary(msg), "");
  assert.equal(trapInvoked, false);
});

test("trace détache les entrées existantes entre branches", () => {
  const source = {
    neuro: {
      id: "existing",
      type: "event",
      source: "test",
      context: {},
      data: {},
      priority: 50,
      trace: [{ node: "source", ts: 1, action: "received" }],
    },
  };
  const branch = { ...source };

  NeuroMessage.trace(branch, "branch", "processed");
  branch.neuro.trace[0].node = "changed";

  assert.equal(source.neuro.trace[0].node, "source");
  assert.equal(NeuroMessage.traceSummary(source), "source");
});

test("trace preserves non-enumerable neuro metadata while copying", () => {
  const neuro = {
    type: "event",
    trace: [{ node: "source", ts: 1, action: "received" }],
  };
  Object.defineProperty(neuro, "id", {
    value: "hidden-id",
    enumerable: false,
    writable: true,
    configurable: true,
  });
  const msg = { neuro };

  NeuroMessage.trace(msg, "branch", "processed");

  assert.equal(Object.hasOwn(msg.neuro, "id"), true);
  assert.equal(Object.getOwnPropertyDescriptor(msg.neuro, "id").enumerable, false);
  assert.equal(msg.neuro.id, "hidden-id");
  assert.equal(msg.neuro.trace.length, 2);
});

test("trace defines its copied trace without invoking an inherited setter", () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "trace");
  let setterInvoked = false;
  const msg = {
    neuro: {
      id: "existing",
      type: "event",
      trace: [],
    },
  };

  try {
    Object.defineProperty(Object.prototype, "trace", {
      configurable: true,
      set() {
        setterInvoked = true;
      },
    });
    NeuroMessage.trace(msg, "branch", "processed");
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(Object.prototype, "trace", originalDescriptor);
    } else {
      delete Object.prototype.trace;
    }
  }

  assert.equal(setterInvoked, false);
  assert.equal(msg.neuro.trace.length, 1);
  assert.equal(msg.neuro.trace[0].node, "branch");
});

test("trace refuse les valeurs imbriquées qui resteraient partagées entre branches", () => {
  const sharedMetadata = { source: "untrusted" };
  const entry = { node: "source", ts: 1, action: "received", metadata: sharedMetadata };
  const neuro = {
    id: "existing",
    type: "event",
    source: "test",
    context: {},
    data: {},
    priority: 50,
    trace: [entry],
  };
  const msg = { neuro };

  assert.equal(NeuroMessage.canTrace(neuro), false);
  assert.equal(NeuroMessage.trace(msg, "branch", "processed"), msg);
  assert.equal(msg.neuro.trace[0].metadata, sharedMetadata);
});

test("trace refuse les valeurs qui ne sont pas représentables de façon fiable en JSON", () => {
  const invalidValues = [undefined, NaN, Infinity, -Infinity, 1n, Symbol("trace")];

  for (const value of invalidValues) {
    const neuro = {
      id: "existing",
      type: "event",
      source: "test",
      context: {},
      data: {},
      priority: 50,
      trace: [{ node: "source", ts: 1, action: "received", extra: value }],
    };
    const msg = { neuro };

    assert.equal(NeuroMessage.canTrace(neuro), false);
    assert.equal(NeuroMessage.trace(msg, "branch", "processed"), msg);
    assert.equal(msg.neuro.trace.length, 1);
  }
});

test("trace refuse les clés symboliques ou non énumérables dans une entrée", () => {
  const symbolEntry = { node: "source", ts: 1, action: "received" };
  Object.defineProperty(symbolEntry, Symbol("metadata"), {
    value: "hidden",
    enumerable: true,
  });
  const hiddenEntry = { node: "source", ts: 1, action: "received" };
  Object.defineProperty(hiddenEntry, "metadata", {
    value: "hidden",
    enumerable: false,
  });

  for (const entry of [symbolEntry, hiddenEntry]) {
    const neuro = {
      id: "existing",
      type: "event",
      source: "test",
      context: {},
      data: {},
      priority: 50,
      trace: [entry],
    };
    const msg = { neuro };

    assert.equal(NeuroMessage.canTrace(neuro), false);
    assert.equal(NeuroMessage.trace(msg, "branch", "processed"), msg);
    assert.equal(msg.neuro.trace[0], entry);
  }
});

test("enrichContext refuse les Proxy et accesseurs sans les exécuter", () => {
  let trapInvoked = false;
  const proxyContext = new Proxy({}, {
    ownKeys() {
      trapInvoked = true;
      throw new Error("context proxy trap invoked");
    },
  });
  const getterContext = {};
  Object.defineProperty(getterContext, "state", {
    enumerable: true,
    get() {
      trapInvoked = true;
      throw new Error("context getter invoked");
    },
  });
  const msg = { payload: "untouched" };

  assert.equal(NeuroMessage.enrichContext(msg, proxyContext), msg);
  assert.equal(NeuroMessage.enrichContext(msg, getterContext), msg);
  assert.equal(Object.hasOwn(msg, "neuro"), false);
  assert.equal(trapInvoked, false);
});

test("enrichContext refuse les Proxy et accesseurs imbriqués sans les exécuter", () => {
  let trapInvoked = false;
  const nestedProxy = new Proxy({}, {
    ownKeys() {
      trapInvoked = true;
      throw new Error("nested context proxy trap invoked");
    },
  });
  const nestedGetter = {};
  Object.defineProperty(nestedGetter, "secret", {
    enumerable: true,
    get() {
      trapInvoked = true;
      throw new Error("nested context getter invoked");
    },
  });
  const msg = { payload: "untouched" };

  assert.equal(NeuroMessage.enrichContext(msg, { state: nestedProxy }), msg);
  assert.equal(Object.hasOwn(msg, "neuro"), false);
  assert.equal(NeuroMessage.enrichContext(msg, { state: nestedGetter }), msg);
  assert.equal(Object.hasOwn(msg, "neuro"), false);
  assert.equal(trapInvoked, false);
});

test("enrichContext copie profondément les valeurs JSON imbriquées", () => {
  const nested = { temperature: 21 };
  const input = { state: nested, goals: [{ name: "reduce_energy" }] };
  const msg = { payload: "safe" };

  NeuroMessage.enrichContext(msg, input);
  nested.temperature = 99;
  input.goals[0].name = "changed";

  assert.equal(msg.neuro.context.state.temperature, 21);
  assert.equal(msg.neuro.context.goals[0].name, "reduce_energy");
});

test("enrichContext preserves an explicitly present undefined payload on raw messages", () => {
  const msg = { payload: undefined };

  NeuroMessage.enrichContext(msg, { state: { ready: true } });

  assert.equal(Object.hasOwn(msg.neuro.data, "payload"), true);
  assert.equal(msg.neuro.data.payload, undefined);
  assert.deepEqual(msg.neuro.context.state, { ready: true });
});

test("enrichContext refuses to initialize metadata from invalid source session IDs", () => {
  let getterInvoked = false;
  const accessorMessage = { payload: "safe" };
  Object.defineProperty(accessorMessage, "sessionId", {
    enumerable: true,
    get() {
      getterInvoked = true;
      throw new Error("sessionId getter invoked");
    },
  });
  const invalidMessage = { payload: "safe", sessionId: false };

  for (const msg of [accessorMessage, invalidMessage]) {
    NeuroMessage.enrichContext(msg, { state: { ready: true } });
    assert.equal(Object.hasOwn(msg, "neuro"), false);
  }
  assert.equal(getterInvoked, false);
});

test("enrichContext refuse les références cycliques sans modifier le message", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const msg = { payload: "untouched" };

  assert.equal(NeuroMessage.enrichContext(msg, { state: cyclic }), msg);
  assert.equal(Object.hasOwn(msg, "neuro"), false);
});

test("enrichContext copie les clés dangereuses sans modifier les prototypes", () => {
  const contextData = JSON.parse('{"__proto__":{"polluted":true},"state":{"temp":21}}');
  const msg = { payload: "safe" };

  NeuroMessage.enrichContext(msg, contextData);

  assert.equal(msg.neuro.type, "event");
  assert.equal(msg.neuro.context.state.temp, 21);
  assert.equal(Object.hasOwn(msg.neuro.context, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(msg.neuro.context), Object.prototype);
  assert.equal({}.polluted, undefined);
});

test("setType rejette les valeurs non textuelles sans modifier le message", () => {
  let trapInvoked = false;
  const invalidType = new Proxy({}, {
    get() {
      trapInvoked = true;
      throw new Error("type proxy trap invoked");
    },
  });
  const msg = { payload: "unchanged" };

  assert.equal(NeuroMessage.setType(msg, invalidType), msg);
  assert.equal(Object.hasOwn(msg, "neuro"), false);
  assert.equal(trapInvoked, false);
});

test("setType preserves an explicitly present undefined payload on raw messages", () => {
  const msg = { payload: undefined };

  NeuroMessage.setType(msg, "observation");

  assert.equal(msg.neuro.type, "observation");
  assert.equal(Object.hasOwn(msg.neuro.data, "payload"), true);
  assert.equal(msg.neuro.data.payload, undefined);
});

test("trace ne modifie pas le message quand nodeName ou action n'est pas une chaîne", () => {
  let trapInvoked = false;
  const invalidValue = new Proxy({}, {
    get() {
      trapInvoked = true;
      throw new Error("argument trap invoked");
    },
  });
  const rawMessage = { payload: "untouched" };
  const wrappedMessage = {
    neuro: {
      id: "existing",
      type: "event",
      source: "test",
      context: {},
      data: {},
      priority: 50,
      trace: [],
    },
  };

  assert.equal(NeuroMessage.trace(rawMessage, invalidValue), rawMessage);
  assert.equal(Object.hasOwn(rawMessage, "neuro"), false);
  assert.equal(NeuroMessage.trace(wrappedMessage, "valid-node", invalidValue), wrappedMessage);
  assert.deepEqual(wrappedMessage.neuro.trace, []);
  assert.equal(trapInvoked, false);
});

test("trace preserves an explicitly present undefined payload when initializing neuro metadata", () => {
  const msg = { payload: undefined };
  NeuroMessage.trace(msg, "source");

  assert.equal(Object.hasOwn(msg.neuro.data, "payload"), true);
  assert.equal(msg.neuro.data.payload, undefined);
  assert.equal(msg.neuro.trace.length, 1);
});

test("trace does not initialize neuro metadata from unsafe source accessors or session IDs", () => {
  let getterInvoked = false;
  const payloadAccessor = {};
  Object.defineProperty(payloadAccessor, "payload", {
    enumerable: true,
    get() {
      getterInvoked = true;
      throw new Error("payload getter invoked");
    },
  });
  const sessionAccessor = {};
  Object.defineProperty(sessionAccessor, "sessionId", {
    enumerable: true,
    get() {
      getterInvoked = true;
      throw new Error("sessionId getter invoked");
    },
  });
  const invalidSession = { payload: "safe", sessionId: 0 };

  for (const msg of [payloadAccessor, sessionAccessor, invalidSession]) {
    NeuroMessage.trace(msg, "source");
    assert.equal(Object.hasOwn(msg, "neuro"), false);
  }
  assert.equal(getterInvoked, false);
});

test("traceSummary ignore les messages Proxy sans exécuter leurs traps", () => {
  let trapInvoked = false;
  const msg = new Proxy({}, {
    getOwnPropertyDescriptor() {
      trapInvoked = true;
      throw new Error("message descriptor trap invoked");
    },
  });

  assert.equal(NeuroMessage.traceSummary(msg), "");
  assert.equal(trapInvoked, false);
});
