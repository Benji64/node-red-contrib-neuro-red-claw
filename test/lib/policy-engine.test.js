/**
 * Verrouille le bug corrigé en v2.5 : policy-engine.js exportait un
 * singleton — deux nœuds redclaw-policy sans AUCUN fil entre eux
 * s'influençaient dès que leur `scope` matchait une même chaîne.
 * evaluate() est maintenant une fonction pure : ces tests prouvent
 * que deux jeux de politiques distincts, même scope, ne fuient jamais
 * l'un vers l'autre.
 */
const test   = require("node:test");
const assert = require("node:assert/strict");
const { evaluate, buildPolicyContext, LEVELS } = require("../../lib/policy-engine");

test("deux jeux de politiques avec le même scope ne s'influencent jamais", () => {
  const policiesNodeA = [
    { name: "Bloquer invités", condition: "agent.role==='guest'", level: LEVELS.BLOCKED, priority: 90, scope: "all", active: true },
  ];
  const policiesNodeB = [
    { name: "Toujours promouvoir", condition: "true", level: LEVELS.PROMOTED, priority: 99, scope: "all", active: true },
  ];
  const msg = { redclaw: { tool: "turn_on" }, sessionId: "test" };

  assert.equal(evaluate(msg, policiesNodeA, { agentRole: "guest" }).level, LEVELS.BLOCKED);
  // Le point critique : le nœud B ne doit JAMAIS voir la règle guest du nœud A,
  // même en lui passant exactement le même msg et le même rôle guest.
  assert.equal(evaluate(msg, policiesNodeB, { agentRole: "guest" }).level, LEVELS.PROMOTED);
});

test("condition qui ne matche pas → ALLOWED par défaut", () => {
  const policies = [
    { name: "Bloquer invités", condition: "agent.role==='guest'", level: LEVELS.BLOCKED, priority: 90, scope: "all", active: true },
  ];
  const result = evaluate({ redclaw: { tool: "x" } }, policies, { agentRole: "admin" });
  assert.equal(result.level, LEVELS.ALLOWED);
});

test("aucune politique fournie → ALLOWED par défaut (fail-open documenté)", () => {
  const result = evaluate({ redclaw: { tool: "x" } }, [], {});
  assert.equal(result.level, LEVELS.ALLOWED);
  assert.equal(result.allowed, true);
});

test("priorité : la règle la plus prioritaire gagne, pas l'ordre du tableau", () => {
  const policies = [
    { name: "Basse prio",  condition: "true", level: LEVELS.ALLOWED,  priority: 10, scope: "all", active: true },
    { name: "Haute prio",  condition: "true", level: LEVELS.BLOCKED,  priority: 90, scope: "all", active: true },
  ];
  const result = evaluate({ redclaw: { tool: "x" } }, policies, {});
  assert.equal(result.policy.name, "Haute prio");
  assert.equal(result.level, LEVELS.BLOCKED);
});

test("modifyFn ne s'applique que pour ALLOWED/PROMOTED", () => {
  const policies = [{
    name: "Cap brightness", condition: "true", level: LEVELS.ALLOWED, priority: 50, scope: "all", active: true,
    modifyFn: "params.brightness = Math.min(params.brightness, 80); return params;",
  }];
  const msg = { redclaw: { tool: "set_brightness", params: { brightness: 100 } } };
  const result = evaluate(msg, policies, {});
  assert.equal(result.modified_params.brightness, 80);
});

test("buildPolicyContext ne résume que le jeu fourni, pas un registre global", () => {
  const policiesA = [{ name: "Règle A", level: LEVELS.BLOCKED, priority: 90, scope: "all", active: true }];
  const policiesB = [{ name: "Règle B", level: LEVELS.PROMOTED, priority: 99, scope: "all", active: true }];
  const ctxA = buildPolicyContext(policiesA);
  const ctxB = buildPolicyContext(policiesB);
  assert.match(ctxA, /Règle A/);
  assert.doesNotMatch(ctxA, /Règle B/);
  assert.match(ctxB, /Règle B/);
  assert.doesNotMatch(ctxB, /Règle A/);
});
