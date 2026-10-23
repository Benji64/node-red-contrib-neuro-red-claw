const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const VectorStore = require("../../lib/vector-store");

describe("VectorStore", () => {
  it("ranks semantic matches, filters metadata, and limits context by character budget", t => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-vector-search-"));
    const store = new VectorStore({ name: "search", storageDir });
    t.after(() => {
      store.destroy();
      fs.rmSync(storageDir, { recursive: true, force: true });
    });

    store.upsert("room", "Room temperature is 21 degrees", [1, 0], { sessionId: "room" });
    store.upsert("music", "The playlist contains jazz", [0, 1], { sessionId: "music" });
    store.upsert("nearby", "The room is warm", [0.8, 0.2], { sessionId: "room" });

    const results = store.search([1, 0], {
      k: 2,
      threshold: 0.7,
      filter: doc => doc.metadata.sessionId === "room",
    });

    assert.deepEqual(results.map(result => result.doc.id), ["room", "nearby"]);
    assert.ok(results[0].score > results[1].score);
    assert.deepEqual(store.searchTexts([0, 1], { threshold: 0.99 }), [
      { text: "The playlist contains jazz", score: 1, metadata: { sessionId: "music" } },
    ]);

    const context = store.buildContext([1, 0], 35, { threshold: 0.7 });
    assert.equal(context.context, "Room temperature is 21 degrees");
    assert.equal(context.retrieved, 1);
    assert.equal(context.chars, context.context.length);
  });

  it("honors zero-valued search options and fills context with later fitting results", t => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-vector-boundaries-"));
    const store = new VectorStore({ name: "boundaries", storageDir });
    t.after(() => {
      store.destroy();
      fs.rmSync(storageDir, { recursive: true, force: true });
    });

    store.upsert("long", "A document that exceeds the context budget", [1, 0]);
    store.upsert("short", "Short", [0.9, 0.1]);
    store.upsert("tiny", "Tiny", [0.8, 0.2]);

    assert.deepEqual(store.search([1, 0], { k: 0, threshold: 0 }), []);
    assert.equal(store.search([1, 0], { threshold: 0 }).length, 3);

    const context = store.buildContext([1, 0], 15, { threshold: 0 });
    assert.equal(context.context, "Short\n---\nTiny");
    assert.equal(context.chars, 14);
    assert.equal(context.retrieved, 2);
  });

  it("excludes vectors with incompatible dimensions even when the threshold is zero", t => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-vector-dimensions-"));
    const store = new VectorStore({ name: "dimensions", storageDir });
    t.after(() => {
      store.destroy();
      fs.rmSync(storageDir, { recursive: true, force: true });
    });

    store.upsert("compatible", "Comparable", [1, 0]);
    store.upsert("old-model", "Different model dimensions", [1, 0, 0]);

    assert.deepEqual(
      store.search([0, 1], { threshold: 0 }).map(result => result.doc.id),
      ["compatible"]
    );
  });

  it("rejects invalid vectors on write and search", t => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-vector-invalid-values-"));
    const store = new VectorStore({ name: "invalid-values", storageDir });
    t.after(() => {
      store.destroy();
      fs.rmSync(storageDir, { recursive: true, force: true });
    });

    for (const vector of [[], [1, "2"], [1, Number.NaN], [Infinity]]) {
      assert.throws(() => store.add("Invalid", vector), /Vecteur invalide/);
      assert.throws(() => store.search(vector), /Vecteur de recherche invalide/);
    }
    assert.equal(store.size(), 0);
  });

  it("drops malformed persisted vectors while preserving valid documents", t => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-vector-load-validation-"));
    t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(storageDir, "restored.json"), JSON.stringify([
      { id: "valid", text: "Valid", vector: [1, 0], metadata: {}, ts: 1 },
      { id: "invalid", text: "Invalid", vector: [1, null], metadata: {}, ts: 2 },
    ]));

    const store = new VectorStore({ name: "restored", storageDir });
    t.after(() => store.destroy());

    assert.equal(store.size(), 1);
    assert.equal(store.get("valid").text, "Valid");
    assert.equal(store.get("invalid"), null);
  });

  it("upserts, deletes, clears, and persists documents across instances", t => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-vector-persist-"));
    const store = new VectorStore({ name: "memory", storageDir });
    t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));

    store.upsert("fact", "Original", [1, 0], { version: 1 });
    store.upsert("fact", "Updated", [0, 1], { version: 2 });
    assert.equal(store.size(), 1);
    assert.deepEqual(store.get("fact"), {
      id: "fact",
      text: "Updated",
      vector: [0, 1],
      metadata: { version: 2 },
      ts: store.get("fact").ts,
    });

    store.destroy();
    const restored = new VectorStore({ name: "memory", storageDir });
    t.after(() => restored.destroy());
    assert.equal(restored.size(), 1);
    assert.equal(restored.get("fact").text, "Updated");

    restored.delete("fact");
    assert.equal(restored.size(), 0);
    restored.upsert("temporary", "Temporary", [1, 0]);
    restored.clear();
    assert.equal(restored.size(), 0);
  });

  it("purges the oldest documents when maxDocs is exceeded", t => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-vector-limit-"));
    const store = new VectorStore({ name: "limited", storageDir, maxDocs: 2 });
    t.after(() => {
      store.destroy();
      fs.rmSync(storageDir, { recursive: true, force: true });
    });

    store.upsert("first", "First", [1, 0]);
    store.upsert("second", "Second", [1, 0]);
    store.upsert("third", "Third", [1, 0]);

    assert.equal(store.size(), 2);
    assert.equal(store.get("first"), null);
    assert.equal(store.get("third").text, "Third");
  });

  it("uses the default maxDocs for invalid constructor limits", t => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-vector-invalid-limit-"));
    t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));

    for (const maxDocs of [0, -1, 1.5, "2abc", Number.NaN, Infinity]) {
      const store = new VectorStore({ name: "invalid", storageDir, maxDocs });
      assert.equal(store.maxDocs, 10000);
      store.destroy();
    }
  });
});
