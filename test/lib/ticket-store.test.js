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
  store.addToolCall(t, "sensor.read", { sensor: { id: "room" } }, true, 5);
  store.addLlmCall(t, 2, 3, 4);

  const fetched = store.get("r1");
  fetched.status = "sabotage";
  fetched.steps.push("mutated");
  fetched.tool_calls[0].params.sensor.id = "tampered";
  fetched.llm_calls[0].tokens_in = 999;
  assert.equal(store.get("r1").status, "running", "la mutation externe ne doit jamais atteindre le cache");
  assert.deepEqual(store.get("r1").steps, ["sensor.read:✓", "llm(~2tk)"]);
  assert.equal(store.get("r1").tool_calls[0].params.sensor.id, "room");
  assert.equal(store.get("r1").llm_calls[0].tokens_in, 2);

  const viaRecent = store.recent(1)[0];
  viaRecent.status = "sabotage2";
  viaRecent.tool_calls[0].params.sensor.id = "tampered again";
  assert.equal(store.get("r1").status, "running");
  assert.equal(store.get("r1").tool_calls[0].params.sensor.id, "room");

  // Le builder-pattern reste intact : complete() sur la référence VIVANTE
  // rendue par create() doit toujours fonctionner normalement.
  const done = store.complete(t, "ok");
  assert.equal(done.status, "completed");
});

test("stats() returns no summary for zero or invalid limits", () => {
  const store = new TicketStore(tmpDir("ticket-stats-limits"));
  const first = store.create("r1", "s", "sess", "x");
  store.complete(first, "ok");
  const second = store.create("r2", "s", "sess", "y");
  store.fail(second, "err");

  assert.equal(store.stats(0), null);
  assert.equal(store.stats(0.5), null);
  assert.equal(store.stats(-1), null);
  assert.equal(store.stats(Number.NaN), null);
  assert.equal(store.stats(1).total, 1);
});

test("loadFromDisk(0) returns no records instead of interpreting -0 as the full file", () => {
  const dir = tmpDir("ticket-zero-limit");
  const store = new TicketStore(dir);
  const ticket = store.create("r1", "s", "sess", "x");
  store.complete(ticket, "ok");

  assert.deepEqual(store.loadFromDisk(0), []);
  assert.equal(store.loadFromDisk(1).length, 1);
});

test("rotate(0) removes all persisted records and invalid limits leave the file unchanged", () => {
  const dir = tmpDir("ticket-rotate-limits");
  const store = new TicketStore(dir);
  for (let i = 1; i <= 3; i++) {
    const ticket = store.create(`r${i}`, "s", "sess", "x");
    store.complete(ticket, "ok");
  }

  const file = path.join(dir, "tickets.jsonl");
  const original = fs.readFileSync(file, "utf8");
  assert.equal(store.rotate(-1), 0);
  assert.equal(store.rotate(1.5), 0);
  assert.equal(fs.readFileSync(file, "utf8"), original);

  assert.equal(store.rotate(0), 3);
  assert.equal(fs.readFileSync(file, "utf8"), "");
  assert.deepEqual(store.loadFromDisk(), []);
});

test("recent() and loadFromDisk() return no records for negative or non-finite limits", () => {
  const dir = tmpDir("ticket-invalid-limit");
  const store = new TicketStore(dir);
  const ticket = store.create("r1", "s", "sess", "x");
  store.complete(ticket, "ok");

  assert.deepEqual(store.recent(-1), []);
  assert.deepEqual(store.recent(Number.NaN), []);
  assert.deepEqual(store.loadFromDisk(-1), []);
  assert.deepEqual(store.loadFromDisk(Number.NaN), []);
  assert.deepEqual(store.loadFromDisk(0.5), []);
});
