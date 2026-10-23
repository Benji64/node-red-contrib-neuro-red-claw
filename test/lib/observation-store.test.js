const test = require("node:test");
const assert = require("node:assert/strict");
const { ObservationStore } = require("../../lib/observation-store");

test("records, updates, snapshots, and summarizes current observations", () => {
  const store = new ObservationStore();
  store.record("room", "temperature", 21, { unit: "°C", label: "Room temperature" });
  store.record("room", "presence", true);
  store.record("garden", "humidity", 48, { unit: "%" });

  assert.equal(store.size(), 3);
  const firstId = store.current()[0].id;
  assert.equal(typeof firstId, "string");
  assert.ok(firstId.length > 0);
  assert.equal(store.fromSource("room").length, 2);
  assert.equal(
    store.buildPerceptionSummary(),
    "[room] temperature: 21°C, presence: true\n[garden] humidity: 48%",
  );

  const previous = store.snapshot();
  store.record("room", "temperature", 24, { unit: "°C" });
  assert.notEqual(store.current().find(obs => obs.key === "temperature").id, firstId);
  const changes = store.detectChanges(previous, 0.1);

  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, "changed");
  assert.equal(changes[0].prev, 21);
  assert.ok(Math.abs(changes[0].delta - 3 / 21) < 1e-12);
});

test("record, current, fromSource, and snapshot return defensive deep copies", () => {
  const store = new ObservationStore();
  const payload = {
    state: { temperature: 21 },
    tags: ["room"],
    attachment: Buffer.from([1, 2]),
  };
  const recorded = store.record("room", "reading", payload);
  payload.state.temperature = 99;
  payload.tags.push("external");
  payload.attachment[0] = 9;

  const expected = {
    state: { temperature: 21 },
    tags: ["room"],
    attachment: Buffer.from([1, 2]),
  };
  assert.deepEqual(store.current()[0].value, expected);

  recorded.value.state.temperature = 30;
  recorded.value.tags.push("record-result");
  recorded.value.attachment[0] = 8;
  const current = store.current();
  current[0].value.state.temperature = 31;
  current[0].value.attachment[1] = 8;
  const fromSource = store.fromSource("room");
  fromSource[0].value.tags.push("source-result");
  const snapshot = store.snapshot();
  snapshot["room:reading"].value.state.temperature = 32;
  snapshot["room:reading"].value.attachment.fill(8);

  assert.deepEqual(store.current()[0].value, expected);
});

test("reports new and non-numeric changes while honoring the numeric threshold", () => {
  const store = new ObservationStore();
  const previous = {
    "room:temperature": { value: 20 },
    "room:presence": { value: false },
  };
  store.record("room", "temperature", 21);
  store.record("room", "presence", true);
  store.record("garden", "humidity", 45);

  const changes = store.detectChanges(previous, 0.1);
  assert.deepEqual(
    changes.map(({ source, key, type, prev }) => ({ source, key, type, prev })),
    [
      { source: "room", key: "presence", type: "changed", prev: false },
      { source: "garden", key: "humidity", type: "new", prev: undefined },
    ],
  );
});

test("expires stale observations and safely summarizes arbitrary source names", t => {
  const store = new ObservationStore();
  const realNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  t.after(() => {
    Date.now = realNow;
  });

  store.record("__proto__", "status", "available", { ttl: 100 });
  store.record("sensor", "value", 1, { ttl: 10 });
  now = 1020;

  assert.deepEqual(store.fromSource("__proto__").map(obs => obs.value), ["available"]);
  assert.equal(store.size(), 1);
  assert.equal(store.buildPerceptionSummary(), "[__proto__] status: available");

  store.clear();
  assert.equal(store.size(), 0);
  assert.equal(store.buildPerceptionSummary(), "Aucune observation disponible.");
});

test("allows immediate expiry and defaults malformed, negative, or overflowing TTLs", () => {
  const store = new ObservationStore();

  assert.equal(store.record("sensor", "instant", 1, { ttl: 0 }).ttl, 0);
  assert.equal(store.current().some(obs => obs.key === "instant"), false);

  for (const ttl of [-1, "50ms", 2147483648, Infinity]) {
    assert.equal(store.record("sensor", String(ttl), 1, { ttl }).ttl, 300000);
  }
});
