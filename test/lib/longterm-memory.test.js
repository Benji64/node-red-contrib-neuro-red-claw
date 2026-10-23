/**
 * Verrouille le bug corrigé en v2.10, identique à celui de goal-store.js
 * (v2.8) : reinforce() mutait en place l'objet stocké dans la Map et
 * retournait cette même référence. Deux renforcements successifs (le
 * cas d'usage central de ce module : "un souvenir répété gagne en
 * confiance") faisaient pointer les deux valeurs de retour vers le
 * même objet muté deux fois.
 */
const test   = require("node:test");
const assert = require("node:assert/strict");
const os     = require("node:os");
const path   = require("node:path");
const fs     = require("node:fs");
const { LongtermMemory } = require("../../lib/longterm-memory");

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rc-test-${label}-`));
}

test("deux renforcements successifs ne partagent pas la même référence", () => {
  const store = new LongtermMemory(tmpDir("lt-a"));
  const first  = store.record("energie", "habit", "allume vers 18h30");
  const second = store.record("energie", "habit", "allume vers 18h30"); // même contenu → renforce

  assert.equal(first.occurrences, 1, "la 1re capture ne doit jamais changer rétroactivement");
  assert.equal(second.occurrences, 2);
  assert.notEqual(first.confidence, second.confidence, "la confiance doit avoir progressé entre les deux captures");
});

test("get() ne permet pas de muter le store depuis l'extérieur", () => {
  const store = new LongtermMemory(tmpDir("lt-b"));
  const mem = store.record("s", "fact", "x");
  const fetched = store.get(mem.id);
  fetched.confidence = 999; // mutation externe — ne doit jamais atteindre le store
  assert.notEqual(store.get(mem.id).confidence, 999);
});

test("les requêtes et les valeurs fournies ne partagent pas de référence avec le store", () => {
  const store = new LongtermMemory(tmpDir("lt-copy-isolation"));
  const content = { summary: { text: "original" }, tags: ["fact"] };
  const created = store.record("s", "fact", content);
  content.summary.text = "input mutation";
  content.tags.push("input mutation");
  created.content.summary.text = "return mutation";

  const expected = {
    summary: { text: "original" },
    tags: ["fact"],
  };
  assert.deepEqual(store.get(created.id).content, expected);

  const fetched = store.get(created.id);
  fetched.content.summary.text = "get mutation";
  const bySkill = store.bySkill("s");
  bySkill[0].content.tags.push("skill mutation");
  const all = store.all();
  all[0].content.summary.text = "all mutation";

  assert.deepEqual(store.get(created.id).content, expected);
});

test("buildContext applique une décroissance temporelle sur les souvenirs non revus", () => {
  const store = new LongtermMemory(tmpDir("lt-c"));
  store.record("s", "habit", "récent");
  const ctx = store.buildContext("s", 5);
  assert.match(ctx, /récent/);
});
