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

test("isValid distingue un message enveloppé d'un message brut", () => {
  assert.equal(NeuroMessage.isValid({ payload: "x" }), false);
  const wrapped = NeuroMessage.wrap({ payload: "x" }, { type: "event" });
  assert.equal(NeuroMessage.isValid(wrapped), true);
});
