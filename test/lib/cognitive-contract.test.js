/**
 * Verrouille le validateur de contrats cognitifs — la valeur du
 * système dépend de sa capacité à détecter une violation SANS jamais
 * se laisser tromper par une comparaison par référence.
 */
const test   = require("node:test");
const assert = require("node:assert/strict");
const packageJson = require("../../package.json");
const {
  loadContract,
  loadAllContracts,
  validateContractDocument,
  snapshot,
  validate,
} = require("../../lib/cognitive-contract");

test("charge un vrai contrat existant", () => {
  const c = loadContract("redclaw-goal");
  assert.equal(c.node, "redclaw-goal");
  assert.equal(c.category, "motivation");
  assert.ok(c.writes.includes("goal_context"));
  assert.deepEqual(loadContract("redclaw-policy").outputSemantics, ["allow", "review", "deny"]);
  assert.deepEqual(loadContract("security-gate").outputSemantics, ["allow", "review", "deny"]);
  assert.deepEqual(loadContract("neuro-approval").outputSemantics, ["queue", "approve", "reject"]);
  assert.deepEqual(loadContract("redclaw-diverge").authority, ["propose"]);
  assert.deepEqual(loadContract("redclaw-diverge").cannot, ["execute", "authorize", "activate_learning"]);
  assert.deepEqual(loadContract("security-gate").responsibilities, [
    "technical_action_validation",
    "one_time_action_authorization",
  ]);
  assert.deepEqual(loadContract("redclaw-reflect").cannot, [
    "activate_learning",
    "execute",
    "change_active_policy",
  ]);
  assert.deepEqual(loadContract("redclaw-orchestrator").owns, [
    "redclaw.tool",
    "redclaw_llm_id",
    "redclaw_call_started_at",
    "redclaw_decision_id",
    "redclaw_observation_link",
  ]);
  assert.deepEqual(loadContract("redclaw-policy").owns, ["redclaw_policy"]);
  assert.deepEqual(loadContract("neuro-approval").owns, ["redclaw_approval"]);
  assert.deepEqual(
    loadContract("mcp-router").owns,
    ["redclaw_dispatch_authorization"],
  );
  assert.deepEqual(loadContract("mcp-adapter").owns, ["adaptateur"]);
  assert.deepEqual(loadContract("neuro-context").owns, ["context_summary"]);
  assert.deepEqual(
    loadContract("neuro-longterm").owns,
    ["longterm_context", "longterm_items"],
  );
  assert.deepEqual(
    loadContract("neuro-trust").owns,
    ["redclaw_trust", "trust_context"],
  );
  assert.deepEqual(
    loadContract("redclaw-observe").owns,
    ["ora_perception", "ora_changes", "ora_trigger", "ora_observation_outcome"],
  );
  assert.deepEqual(
    loadContract("neuro-chat").owns,
    ["ui_payload", "ui_role", "ui_ts", "ui_source", "ui_category"],
  );
  assert.deepEqual(
    loadContract("redclaw-diverge").owns,
    ["redclaw_diverge", "redclaw_lens", "redclaw_diverge_id", "redclaw_frame_prompt"],
  );
  assert.deepEqual(
    loadContract("redclaw-goal").owns,
    ["redclaw_goal", "redclaw_goal_achieved"],
  );
  assert.deepEqual(
    loadContract("neuro-embed").owns,
    ["embed_context", "embed_results", "embed_vector", "embed_chars", "embed_retrieved", "embed_error"],
  );
  assert.deepEqual(
    loadContract("redclaw-hub").owns,
    ["redclaw_hub_call", "redclaw_hub_context", "redclaw_hub_result", "redclaw_hub_error"],
  );
  assert.deepEqual(
    loadContract("redclaw-reflect").owns,
    ["redclaw_reflect", "redclaw_adjustments", "redclaw_learning_candidates", "reflect_skill"],
  );
  assert.deepEqual(
    loadContract("redclaw-skill").owns,
    ["redclaw_hub_callId", "redclaw.userMessage", "redclaw.skill"],
  );
  assert.deepEqual(
    loadContract("security-gate").owns,
    ["redclaw_confirm_request", "redclaw_safety"],
  );
  assert.deepEqual(
    loadContract("redclaw-response-review").owns,
    ["redclaw_response_review_receipt"],
  );
});

test("chaque nœud cognitif publié possède un contrat explicite", () => {
  const all = loadAllContracts();
  assert.equal(Object.getPrototypeOf(all), null);
  const excludedConfigurationNodes = new Set([
    "llm-config",
    "embed-config",
    "redclaw-policy-config",
  ]);
  const publishedNodes = Object.keys(packageJson["node-red"].nodes)
    .filter(nodeType => !excludedConfigurationNodes.has(nodeType))
    .sort();
  const contractedNodes = Object.keys(all).sort();

  assert.deepEqual(contractedNodes, publishedNodes);
  assert.equal(contractedNodes.length, 19);
  for (const nodeType of contractedNodes) {
    assert.ok(
      all[nodeType].responsibilities.length > 0,
      `Contract "${nodeType}" must declare at least one responsibility`,
    );
  }
});

test("rejette les déclarations de chemins de contrat qui ne sont pas des tableaux de chemins", () => {
  for (const field of ["reads", "writes", "forbidden", "owns"]) {
    assert.throws(
      () => validateContractDocument("test-node", {
        node: "test-node",
        category: "reasoning",
        [field]: "payload",
      }),
      new RegExp(`"${field}" must be an array`),
    );
  }
});

test("rejette les trous dans les tableaux de chemins et de métadonnées", () => {
  for (const field of ["reads", "writes", "forbidden", "owns", "responsibilities", "authority", "cannot"]) {
    const sparseValues = [];
    sparseValues.length = 1;
    assert.throws(
      () => validateContractDocument("test-node", {
        node: "test-node",
        category: "reasoning",
        [field]: sparseValues,
      }),
      new RegExp(`field "${field}" must be an array`),
    );
  }
});

test("rejette les chemins ambigus ou les wildcards partiels", () => {
  for (const invalidPath of ["context..memory", ".payload", "payload.", "context.*.x*", "red claw"]) {
    assert.throws(
      () => validateContractDocument("test-node", {
        node: "test-node",
        category: "reasoning",
        reads: [invalidPath],
      }),
      /must be an array of valid paths/,
    );
  }
});

test("rejette les chemins et métadonnées dupliqués", () => {
  for (const field of ["reads", "writes", "forbidden", "owns", "responsibilities", "authority", "cannot"]) {
    assert.throws(
      () => validateContractDocument("test-node", {
        node: "test-node",
        category: "reasoning",
        [field]: field === "reads" || field === "writes" || field === "forbidden" || field === "owns"
          ? ["context.value", "context.value"]
          : ["propose", "propose"],
      }),
      new RegExp(`field "${field}" must not contain duplicate entries`),
    );
  }
});

test("rejette l'identité, la catégorie et la cardinalité des sorties invalides", () => {
  const base = { node: "test-node", category: "reasoning" };
  const sparseOutputSemantics = [];
  sparseOutputSemantics.length = 1;

  assert.throws(
    () => validateContractDocument("test-node", { ...base, node: "other-node" }),
    /must declare node/,
  );
  assert.throws(
    () => validateContractDocument("test-node", { ...base, category: "" }),
    /non-empty category/,
  );
  assert.throws(
    () => validateContractDocument("test-node", { ...base, category: " reasoning " }),
    /category must not contain surrounding whitespace/,
  );
  assert.throws(
    () => validateContractDocument("test-node", { ...base, outputs: -1 }),
    /non-negative integer or "dynamic"/,
  );
  assert.throws(
    () => validateContractDocument("test-node", {
      ...base,
      outputs: 2,
      outputSemantics: ["allow"],
    }),
    /Invalid outputSemantics/,
  );
  assert.throws(
    () => validateContractDocument("test-node", {
      ...base,
      outputs: 1,
      outputSemantics: sparseOutputSemantics,
    }),
    /Invalid outputSemantics/,
  );
});

test("rejette les propriétés inconnues ou mal orthographiées du contrat", () => {
  assert.throws(
    () => validateContractDocument("test-node", {
      node: "test-node",
      category: "reasoning",
      responsabilities: ["hypothesis_generation"],
    }),
    /unsupported fields: responsabilities/,
  );
});

test("rejette une capacité déclarée à la fois autorisée et interdite", () => {
  assert.throws(
    () => validateContractDocument("test-node", {
      node: "test-node",
      category: "reasoning",
      authority: ["execute"],
      cannot: ["execute"],
    }),
    /same authority and cannot capability: execute/,
  );
});

test("accepte les contrats à sorties dynamiques et les chemins valides", () => {
  const contract = validateContractDocument("test-node", {
    node: "test-node",
    category: "reasoning",
    outputs: "dynamic",
    reads: ["context.*"],
    writes: ["reasoning.*"],
    forbidden: ["action.*"],
    owns: ["reasoning.*"],
  });
  assert.equal(contract.outputs, "dynamic");
  assert.deepEqual(contract.reads, ["context.*"]);
  assert.deepEqual(contract.writes, ["reasoning.*"]);
  assert.deepEqual(contract.forbidden, ["action.*"]);
  assert.deepEqual(contract.owns, ["reasoning.*"]);
});

test("valide et expose les métadonnées déclaratives de responsabilité et d'autorité", () => {
  const contract = validateContractDocument("test-node", {
    node: "test-node",
    category: "reasoning",
    responsibilities: ["hypothesis_generation"],
    authority: ["propose"],
    cannot: ["execute", "authorize"],
  });

  assert.deepEqual(contract.responsibilities, ["hypothesis_generation"]);
  assert.deepEqual(contract.authority, ["propose"]);
  assert.deepEqual(contract.cannot, ["execute", "authorize"]);
  for (const field of ["responsibilities", "authority", "cannot"]) {
    assert.throws(
      () => validateContractDocument("test-node", {
        node: "test-node",
        category: "reasoning",
        [field]: [""],
      }),
      new RegExp(`"${field}" must be an array of non-empty strings`),
    );
  }
});

test("détecte une violation : champ modifié hors writes", () => {
  const contract = { node: "test", writes: ["payload"], forbidden: [] };
  const before = snapshot({ payload: "x", redclaw_call_id: "abc" });
  const after  = { payload: "y", redclaw_call_id: "SABOTÉ" };
  const result = validate(contract, before, after);
  assert.equal(result.ok, false);
  assert.match(result.violations[0], /redclaw_call_id/);
});

test("détecte l'ajout d'un champ undefined interdit", () => {
  const contract = { node: "test", writes: [], forbidden: ["secret"] };
  const before = snapshot({ payload: "x" });
  const after = { payload: "x", secret: undefined };

  const result = validate(contract, before, after);

  assert.equal(result.ok, false);
  assert.deepEqual(result.changed, ["secret"]);
  assert.match(result.violations[0], /secret/);
});

test("snapshot et validate préservent un champ undefined inchangé", () => {
  const contract = { node: "test", writes: [], forbidden: [] };
  const before = snapshot({ payload: "x", optional: undefined });
  const after = { payload: "x", optional: undefined };

  const result = validate(contract, before, after);

  assert.equal(result.ok, true);
  assert.deepEqual(result.changed, []);
});

test("snapshot conserve la sémantique JSON de toJSON et des valeurs non sérialisables", () => {
  const result = snapshot({
    optional: undefined,
    omitted: { toJSON: () => undefined },
    callback() {},
    values: [undefined, () => {}],
  });

  assert.equal(Object.hasOwn(result, "optional"), true);
  assert.equal(result.optional, undefined);
  assert.equal(Object.hasOwn(result, "omitted"), false);
  assert.equal(Object.hasOwn(result, "callback"), false);
  assert.deepEqual(result.values, [null, null]);
});

test("snapshot préserve les contenus des Map et Set", () => {
  const before = snapshot({
    payload: new Map([["key", { value: 1 }]]),
    tags: new Set(["safe"]),
  });
  const after = {
    payload: new Map([["key", { value: 2 }]]),
    tags: new Set(["safe", "new"]),
  };

  const result = validate({ node: "test", writes: [], forbidden: [] }, before, after);

  assert.equal(result.ok, false);
  assert.deepEqual(result.changed, ["payload", "tags"]);
  assert.equal(before.payload.get("key").value, 1);
  assert.equal(before.tags.has("new"), false);
});

test("snapshot préserve les valeurs structurées non JSON", () => {
  const before = snapshot({
    error: new Error("before"),
    pattern: /before/gi,
    bytes: new Uint8Array([1]),
    integer: 1n,
  });
  const after = {
    error: new Error("after"),
    pattern: /after/g,
    bytes: new Uint8Array([2]),
    integer: 2n,
  };

  const result = validate({ node: "test", writes: [], forbidden: [] }, before, after);

  assert.equal(result.ok, false);
  assert.deepEqual(result.changed, ["error", "pattern", "bytes", "integer"]);
  assert.equal(before.error.message, "before");
  assert.equal(before.pattern.source, "before");
  assert.deepEqual([...before.bytes], [1]);
  assert.equal(before.integer, 1n);
});

test("snapshot conserve et détache les références cycliques", () => {
  const original = { value: 1 };
  original.self = original;

  const cloned = snapshot(original);

  assert.equal(cloned.self, cloned);
  original.value = 2;
  assert.equal(cloned.value, 1);
});

test("le diff ignore les liens cycliques inchangés", () => {
  const before = { value: 1 };
  before.self = before;
  const after = { value: 2 };
  after.self = after;

  const result = validate(
    { node: "test", writes: ["value"], forbidden: [] },
    snapshot(before),
    after,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.changed, ["value"]);
});

test("le diff détecte les cycles rompus et chaque chemin partagé", () => {
  const before = { value: 1 };
  before.self = before;
  const brokenCycle = { value: 1, self: { value: 1 } };
  const cycleResult = validate(
    { node: "test", writes: [], forbidden: [] },
    snapshot(before),
    brokenCycle,
  );
  assert.deepEqual(cycleResult.changed, ["self"]);

  const shared = { value: 1 };
  const aliasResult = validate(
    { node: "test", writes: ["x.value"], forbidden: [] },
    snapshot({ x: shared, y: shared }),
    { x: { value: 2 }, y: { value: 2 } },
  );
  assert.equal(aliasResult.ok, false);
  assert.deepEqual(aliasResult.changed, ["x.value", "y.value"]);
  assert.match(aliasResult.violations[0], /y\.value/);
});

test("un chemin enfant est couvert si son parent est dans writes", () => {
  const contract = { node: "test", writes: ["redclaw"], forbidden: [] };
  const before = snapshot({ redclaw: { tool: "x" } });
  const after  = { redclaw: { tool: "x", params: { a: 1 } } };
  const result = validate(contract, before, after);
  assert.equal(result.ok, true);
});

test("un wildcard de chemin dans writes couvre les champs correspondants", () => {
  const contract = { node: "test", writes: ["reasoning.*"], forbidden: [] };
  const before = snapshot({ reasoning: {} });
  const after = {
    reasoning: {
      hypotheses: [{ text: "A", evidence: { source: "fixture" } }],
      selected: true,
    },
  };

  const result = validate(contract, before, after);

  assert.equal(result.ok, true);
  assert.deepEqual(result.changed, [
    "reasoning.hypotheses",
    "reasoning.selected",
  ]);
});

test("un champ forbidden produit un message de violation critique distinct", () => {
  const contract = { node: "test", writes: [], forbidden: ["redclaw.tool"] };
  const before = snapshot({ redclaw: { tool: "turn_on" } });
  const after  = { redclaw: { tool: "turn_off" } };
  const result = validate(contract, before, after);
  assert.equal(result.ok, false);
  assert.match(result.violations[0], /VIOLATION CRITIQUE/);
});

test("forbidden reste interdit même si un parent large figure dans writes", () => {
  const contract = {
    node: "test",
    writes: ["redclaw"],
    forbidden: ["redclaw.tool"],
  };
  const before = snapshot({ redclaw: { tool: "safe" } });
  const after = { redclaw: { tool: "unsafe" } };

  const result = validate(contract, before, after);

  assert.equal(result.ok, false);
  assert.match(result.violations[0], /VIOLATION CRITIQUE/);
});

test("un wildcard dans forbidden marque le chemin comme interdit", () => {
  const contract = {
    node: "test",
    writes: ["redclaw"],
    forbidden: ["redclaw.*"],
  };
  const before = snapshot({ redclaw: { tool: "safe" } });
  const after = { redclaw: { tool: "unsafe" } };

  const result = validate(contract, before, after);

  assert.equal(result.ok, false);
  assert.match(result.violations[0], /redclaw\.tool/);
});

test("_msgid (ajouté par Node-RED) est toujours ignoré", () => {
  const contract = { node: "test", writes: [], forbidden: [] };
  const before = snapshot({ payload: "x" });
  const after  = { payload: "x", _msgid: "abc123" };
  const result = validate(contract, before, after);
  assert.equal(result.ok, true);
});

test("aucune modification → toujours valide", () => {
  const contract = { node: "test", writes: [], forbidden: [] };
  const before = snapshot({ payload: "x", redclaw: { tool: "y" } });
  const after  = { payload: "x", redclaw: { tool: "y" } };
  const result = validate(contract, before, after);
  assert.equal(result.ok, true);
});

test("snapshot() protège réellement : muter after ne change jamais before rétroactivement", () => {
  const original = { redclaw: { params: { level: 1 } } };
  const before = snapshot(original);
  original.redclaw.params.level = 999;
  assert.equal(before.redclaw.params.level, 1);
});

test("un tableau modifié est détecté comme changement", () => {
  const contract = { node: "test", writes: ["items"], forbidden: [] };
  const before = snapshot({ items: [1, 2] });
  const after  = { items: [1, 2, 3] };
  const result = validate(contract, before, after);
  assert.equal(result.ok, true);
  assert.ok(result.changed.includes("items"));
});

test("compare les objets contenus dans les tableaux par valeur, sans dépendre de l'ordre des clés", () => {
  const contract = { node: "test", writes: [], forbidden: [] };
  const before = snapshot({ items: [{ first: 1, second: { enabled: true } }] });
  const after = { items: [{ second: { enabled: true }, first: 1 }] };

  const result = validate(contract, before, after);

  assert.equal(result.ok, true);
  assert.deepEqual(result.changed, []);
});

test("détecte une modification de valeur imbriquée dans un tableau", () => {
  const contract = { node: "test", writes: [], forbidden: [] };
  const before = snapshot({ items: [{ nested: { value: 1 } }] });
  const after = { items: [{ nested: { value: 2 } }] };

  const result = validate(contract, before, after);

  assert.equal(result.ok, false);
  assert.deepEqual(result.changed, ["items"]);
});

test("diffère les objets profondément imbriqués sans dépasser la pile", () => {
  const depth = 4000;
  const before = {};
  const after = {};
  let beforeCursor = before;
  let afterCursor = after;
  for (let index = 0; index < depth; index++) {
    beforeCursor.next = {};
    afterCursor.next = {};
    beforeCursor = beforeCursor.next;
    afterCursor = afterCursor.next;
  }
  beforeCursor.value = 1;
  afterCursor.value = 2;

  const result = validate({ node: "test", writes: [], forbidden: [] }, snapshot(before), after);

  assert.equal(result.ok, false);
  assert.equal(result.changed.length, 1);
  assert.match(result.changed[0], /^next\.next\./);
  assert.match(result.changed[0], /\.value$/);
});
