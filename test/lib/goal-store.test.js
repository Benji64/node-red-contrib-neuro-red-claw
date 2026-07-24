/**
 * Vérifie le calcul de progression pour les 3 directions d'objectif —
 * un calcul inversé silencieusement (minimize traité comme maximize)
 * ferait dire à un agent qu'il a atteint un objectif alors qu'il
 * consomme deux fois trop, sans jamais lever d'erreur visible.
 */
const test   = require("node:test");
const assert = require("node:assert/strict");
const os     = require("node:os");
const path   = require("node:path");
const fs     = require("node:fs");
const { GoalStore } = require("../../lib/goal-store");

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rc-test-${label}-`));
}

test("minimize : progression augmente quand current descend vers target", () => {
  const store = new GoalStore(tmpDir("goal-a"));
  store.upsert({ id: "g1", skill: "energie", name: "conso", direction: "minimize", target: 200, unit: "kWh" });
  const at400 = store.update("g1", 400);
  const at200 = store.update("g1", 200);
  assert.ok(at200.progress > at400.progress, "descendre vers la cible doit augmenter la progression");
  assert.equal(at200.progress, 1, "atteindre exactement la cible = 100%");
  assert.equal(at200.status, "achieved");
});

test("maximize : progression augmente quand current monte vers target", () => {
  const store = new GoalStore(tmpDir("goal-b"));
  store.upsert({ id: "g2", skill: "confort", name: "temp", direction: "maximize", target: 21 });
  const at10 = store.update("g2", 10);
  const at21 = store.update("g2", 21);
  assert.ok(at21.progress > at10.progress);
  assert.equal(at21.status, "achieved");
});

test("reach : atteint seulement si current >= target", () => {
  const store = new GoalStore(tmpDir("goal-c"));
  store.upsert({ id: "g3", skill: "s", name: "n", direction: "reach", target: 50 });
  assert.notEqual(store.update("g3", 30).status, "achieved");
  assert.equal(store.update("g3", 50).status, "achieved");
});

test("buildGoalContext ne remonte que les objectifs actifs du skill demandé", () => {
  const store = new GoalStore(tmpDir("goal-d"));
  store.upsert({ id: "gA", skill: "energie", name: "Conso A", direction: "minimize", target: 100 });
  store.upsert({ id: "gB", skill: "confort", name: "Temp B",  direction: "maximize", target: 21 });
  const ctx = store.buildGoalContext("energie");
  assert.match(ctx, /Conso A/);
  assert.doesNotMatch(ctx, /Temp B/);
});
