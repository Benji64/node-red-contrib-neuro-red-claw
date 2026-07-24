/**
 * Verrouille le fix v2.10 : get()/all() exposaient la référence brute
 * stockée en interne, mutable par touch()/unregister(). Un consommateur
 * qui garderait un résultat de all() verrait ses champs changer sous
 * ses pieds au prochain touch() d'un autre skill — même famille de
 * bug que goal-store/longterm-memory, appliquée par principe même si
 * le code actuel ne conserve pas de référence assez longtemps pour
 * le déclencher concrètement aujourd'hui.
 */
const test   = require("node:test");
const assert = require("node:assert/strict");
const { SkillRegistry } = require("../../lib/skill-registry");

test("get() retourne une copie — la muter ne touche pas le registre", () => {
  const reg = new SkillRegistry();
  reg.register("energie", "node1", { tools: "turn_on" });
  const s = reg.get("energie");
  s.status = "sabotage";
  assert.equal(reg.get("energie").status, "active");
});

test("all() capturé avant un touch() ne doit pas changer rétroactivement", () => {
  const reg = new SkillRegistry();
  reg.register("energie", "node1", {});
  const before = reg.all()[0];
  reg.touch("energie");
  assert.equal(before.status, "active", "la capture précédente doit rester figée à son état d'origine");
});

test("unregister() marque bien offline pour les lectures suivantes", () => {
  const reg = new SkillRegistry();
  reg.register("s", "n1", {});
  reg.unregister("s");
  assert.equal(reg.get("s").status, "offline");
});
