/**
 * Verrouille le validateur de contrats cognitifs — la valeur du
 * système dépend de sa capacité à détecter une violation SANS jamais
 * se laisser tromper par une comparaison par référence.
 */
const test   = require("node:test");
const assert = require("node:assert/strict");
const { loadContract, loadAllContracts, snapshot, validate } = require("../../lib/cognitive-contract");

test("charge un vrai contrat existant", () => {
  const c = loadContract("redclaw-goal");
  assert.equal(c.node, "redclaw-goal");
  assert.equal(c.category, "motivation");
  assert.ok(c.writes.includes("goal_context"));
});

test("les 18 contrats réels chargent tous sans erreur", () => {
  const all = loadAllContracts();
  assert.equal(Object.keys(all).length, 18);
});

test("détecte une violation : champ modifié hors writes", () => {
  const contract = { node: "test", writes: ["payload"], forbidden: [] };
  const before = snapshot({ payload: "x", redclaw_call_id: "abc" });
  const after  = { payload: "y", redclaw_call_id: "SABOTÉ" };
  const result = validate(contract, before, after);
  assert.equal(result.ok, false);
  assert.match(result.violations[0], /redclaw_call_id/);
});

test("un chemin enfant est couvert si son parent est dans writes", () => {
  const contract = { node: "test", writes: ["redclaw"], forbidden: [] };
  const before = snapshot({ redclaw: { tool: "x" } });
  const after  = { redclaw: { tool: "x", params: { a: 1 } } };
  const result = validate(contract, before, after);
  assert.equal(result.ok, true);
});

test("un champ forbidden produit un message de violation critique distinct", () => {
  const contract = { node: "test", writes: [], forbidden: ["redclaw.tool"] };
  const before = snapshot({ redclaw: { tool: "turn_on" } });
  const after  = { redclaw: { tool: "turn_off" } };
  const result = validate(contract, before, after);
  assert.equal(result.ok, false);
  assert.match(result.violations[0], /VIOLATION CRITIQUE/);
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
