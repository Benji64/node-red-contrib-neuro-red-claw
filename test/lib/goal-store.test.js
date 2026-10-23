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

test("les objectifs avec une cible zéro produisent une progression bornée et cohérente", () => {
  const minimize = new GoalStore(tmpDir("goal-zero-min"));
  minimize.upsert({ id: "min", skill: "s", name: "min", direction: "minimize", target: 0 });
  const minAtZero = minimize.update("min", 0);
  assert.equal(minAtZero.progress, 1);
  assert.equal(minAtZero.status, "achieved");

  const maximize = new GoalStore(tmpDir("goal-zero-max"));
  maximize.upsert({ id: "max", skill: "s", name: "max", direction: "maximize", target: 0 });
  const maxAtZero = maximize.update("max", 0);
  assert.equal(maxAtZero.progress, 1);
  assert.equal(maxAtZero.status, "achieved");

  const reach = new GoalStore(tmpDir("goal-zero-reach"));
  reach.upsert({ id: "reach", skill: "s", name: "reach", direction: "reach", target: 0 });
  const reachBelowZero = reach.update("reach", -1);
  assert.equal(reachBelowZero.progress, 0);
  assert.equal(reachBelowZero.status, "active");
  assert.equal(reach.update("reach", 0).status, "achieved");
});

test("buildGoalContext ne remonte que les objectifs actifs du skill demandé", () => {
  const store = new GoalStore(tmpDir("goal-d"));
  store.upsert({ id: "gA", skill: "energie", name: "Conso A", direction: "minimize", target: 100 });
  store.upsert({ id: "gB", skill: "confort", name: "Temp B",  direction: "maximize", target: 21 });
  const ctx = store.buildGoalContext("energie");
  assert.match(ctx, /Conso A/);
  assert.doesNotMatch(ctx, /Temp B/);
});

test("goal inputs and query results are defensive deep copies", () => {
  const store = new GoalStore(tmpDir("goal-copy-isolation"));
  const input = {
    id: "copy",
    skill: "test",
    name: "copy isolation",
    target: 10,
    context: { source: { label: "original" } },
    tags: ["goal"],
  };
  const created = store.upsert(input);
  input.context.source.label = "input mutation";
  input.tags.push("input mutation");
  created.context.source.label = "return mutation";

  assert.equal(store.get("copy").context.source.label, "original");
  assert.deepEqual(store.get("copy").tags, ["goal"]);

  const fetched = store.get("copy");
  fetched.context.source.label = "get mutation";
  const all = store.all();
  all[0].context.source.label = "all mutation";
  const active = store.active();
  active[0].tags.push("active mutation");
  const bySkill = store.bySkill("test");
  bySkill[0].context.source.label = "skill mutation";

  assert.equal(store.get("copy").context.source.label, "original");
  assert.deepEqual(store.get("copy").tags, ["goal"]);
});

test("loading skips malformed goals and normalizes invalid fields without losing later entries", t => {
  const storageDir = tmpDir("goal-load-validation");
  const timestamp = new Date().toISOString();
  fs.writeFileSync(path.join(storageDir, "goals.json"), JSON.stringify([
    {
      id: "valid-before",
      skill: "energy",
      name: "Valid before",
      target: 100,
      current: 50,
      direction: "maximize",
      priority: "high",
      status: "active",
      progress: 0.5,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    null,
    { id: "missing-name" },
    {
      id: "normalized",
      name: "Normalized",
      target: "not-a-number",
      current: Infinity,
      direction: "unknown",
      priority: "unknown",
      status: "unknown",
      progress: 4,
      deadline: "not-a-date",
    },
    {
      id: "valid-after",
      skill: "energy",
      name: "Valid after",
      target: 20,
      current: 10,
      direction: "maximize",
      status: "active",
      progress: 0.5,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ]));
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));

  const store = new GoalStore(storageDir);

  assert.deepEqual(store.all().map(goal => goal.id), ["valid-before", "normalized", "valid-after"]);
  assert.equal(store.get("valid-before").progress, 0.5);
  assert.equal(store.get("normalized").target, null);
  assert.equal(store.get("normalized").current, null);
  assert.equal(store.get("normalized").direction, "minimize");
  assert.equal(store.get("normalized").priority, "medium");
  assert.equal(store.get("normalized").status, "active");
  assert.equal(store.get("normalized").progress, 0);
  assert.doesNotThrow(() => store.buildGoalContext());
});
