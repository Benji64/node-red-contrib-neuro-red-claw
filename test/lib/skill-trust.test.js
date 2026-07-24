/**
 * Verrouille la formule de confiance (lissage de Laplace) validée
 * manuellement lors de l'implémentation v2.4 : 9 succès / 1 échec
 * doit donner exactement 0.833, pas un simple ratio brut (0.9) qui
 * surestimerait la confiance sur peu d'échantillons.
 */
const test   = require("node:test");
const assert = require("node:assert/strict");
const os     = require("node:os");
const path   = require("node:path");
const fs     = require("node:fs");
const { SkillTrust } = require("../../lib/skill-trust");

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rc-test-${label}-`));
}

test("lissage de Laplace : 9 succès + 1 échec = 0.833 exactement", () => {
  const trust = new SkillTrust(tmpDir("trust-a"));
  for (let i = 0; i < 9; i++) trust.record("energie", "turn_on", true, 200);
  trust.record("energie", "turn_on", false, 500, "timeout");

  const t = trust.getTrust("energie", "turn_on");
  assert.equal(t.trustScore, 0.833);
  assert.equal(t.totalCalls, 10);
  assert.equal(t.lastFailureReason, "timeout");
});

test("aucun appel enregistré → getTrust retourne null (pas 0 ni 1, l'absence est distincte)", () => {
  const trust = new SkillTrust(tmpDir("trust-b"));
  assert.equal(trust.getTrust("x", "y"), null);
});

test("deux tools différents du même skill ont des scores indépendants", () => {
  const trust = new SkillTrust(tmpDir("trust-c"));
  trust.record("energie", "turn_on",  true, 100);
  trust.record("energie", "turn_off", false, 100, "err");
  assert.ok(trust.getTrust("energie", "turn_on").trustScore > trust.getTrust("energie", "turn_off").trustScore);
});

test("lowTrust ne remonte que sous le seuil ET avec un minimum d'échantillons", () => {
  const trust = new SkillTrust(tmpDir("trust-d"));
  trust.record("s", "flaky", false, 100, "err"); // 1 seul échec — pas assez d'échantillons pour juger
  assert.equal(trust.lowTrust(0.7).length, 0);
  trust.record("s", "flaky", false, 100, "err");
  trust.record("s", "flaky", false, 100, "err"); // 3 échecs, 0 succès — maintenant significatif
  assert.equal(trust.lowTrust(0.7).length, 1);
});
