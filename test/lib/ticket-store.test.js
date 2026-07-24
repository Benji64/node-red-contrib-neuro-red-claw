/**
 * Vérifie le cycle de vie create → complete/fail et que le fichier
 * JSONL est bien append-only (audit log immuable) plutôt que réécrit.
 */
const test   = require("node:test");
const assert = require("node:assert/strict");
const os     = require("node:os");
const path   = require("node:path");
const fs     = require("node:fs");
const { TicketStore } = require("../../lib/ticket-store");

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rc-test-${label}-`));
}

test("create → running, puis complete → completed avec durée calculée", () => {
  const store = new TicketStore(tmpDir("ticket-a"));
  const t = store.create("req1", "energie", "sess1", "allume le salon");
  assert.equal(t.status, "running");
  const done = store.complete(t, "La lumière est allumée.");
  assert.equal(done.status, "completed");
  assert.ok(done.duration_ms >= 0);
  assert.equal(done.response, "La lumière est allumée.");
});

test("fail → failed avec le message d'erreur préservé", () => {
  const store = new TicketStore(tmpDir("ticket-b"));
  const t = store.create("req2", "energie", "sess1", "x");
  const failed = store.fail(t, "Timeout tool turn_on");
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "Timeout tool turn_on");
});

test("recent() filtre correctement par skill et status", () => {
  const store = new TicketStore(tmpDir("ticket-c"));
  const a = store.create("r1", "energie", "s", "x"); store.complete(a, "ok");
  const b = store.create("r2", "confort", "s", "x"); store.fail(b, "err");
  assert.equal(store.recent(10, { skill: "energie" }).length, 1);
  assert.equal(store.recent(10, { status: "failed" }).length, 1);
});

test("le fichier JSONL est append-only : les tickets précédents ne sont jamais réécrits", () => {
  const dir = tmpDir("ticket-d");
  const store = new TicketStore(dir);
  const a = store.create("r1", "s", "sess", "x"); store.complete(a, "ok1");
  const b = store.create("r2", "s", "sess", "y"); store.complete(b, "ok2");

  const lines = fs.readFileSync(path.join(dir, "tickets.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).id, "r1");
  assert.equal(JSON.parse(lines[1]).id, "r2");
});

test("get()/recent() retournent des copies — muter le résultat ne touche pas le cache interne", () => {
  const store = new TicketStore(tmpDir("ticket-e"));
  const t = store.create("r1", "s", "sess", "x");
  const fetched = store.get("r1");
  fetched.status = "sabotage";
  assert.equal(store.get("r1").status, "running", "la mutation externe ne doit jamais atteindre le cache");

  const viaRecent = store.recent(1)[0];
  viaRecent.status = "sabotage2";
  assert.equal(store.get("r1").status, "running");

  // Le builder-pattern reste intact : complete() sur la référence VIVANTE
  // rendue par create() doit toujours fonctionner normalement.
  const done = store.complete(t, "ok");
  assert.equal(done.status, "completed");
});
