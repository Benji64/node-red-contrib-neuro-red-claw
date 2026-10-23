const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ConversationMemory = require("../../lib/conversation-memory");

function createMemory(t, options = {}) {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-conversation-memory-"));
  const memory = new ConversationMemory(storageDir, options);
  t.after(() => {
    memory.destroy();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });
  return { memory, storageDir };
}

test("bounds each session while retaining the first message and latest messages", t => {
  const { memory } = createMemory(t, { maxMessages: 3 });

  const session = memory.addMessage("session-1", "user", "first");
  memory.addMessage("session-1", "assistant", "second");
  memory.addMessage("session-1", "user", "third");
  memory.addMessage("session-1", "assistant", { answer: "fourth" });
  const bounded = memory.addMessage("session-1", "user", "fifth");

  assert.deepEqual(
    bounded.messages.map(({ role, content }) => [role, content]),
    [
      ["user", "first"],
      ["assistant", '{"answer":"fourth"}'],
      ["user", "fifth"],
    ],
  );
  assert.match(memory.getSummary("session-1", 1), /U: fifth$/);
  assert.equal(memory.list()[0].count, 3);
});

test("a one-message limit retains only the newest message", t => {
  const { memory } = createMemory(t, { maxMessages: 1 });

  memory.addMessage("session-single", "user", "first");
  const bounded = memory.addMessage("session-single", "assistant", "latest");

  assert.deepEqual(bounded.messages.map(message => message.content), ["latest"]);
});

test("summary exchange limits reject zero and malformed values", t => {
  const { memory } = createMemory(t);
  memory.addMessage("session-summary-limit", "user", "first");
  memory.addMessage("session-summary-limit", "assistant", "second");

  assert.equal(memory.getSummary("session-summary-limit", 0), "");
  assert.equal(memory.getSummary("session-summary-limit", -1), "");
  assert.equal(memory.getSummary("session-summary-limit", 0.5), "");
  assert.equal(memory.getSummary("session-summary-limit", "2exchanges"), "");
  assert.equal(memory.getSummary("session-summary-limit", 1), "Historique récent:\nU: first\nA: second");
});

test("session access and message results do not expose cached mutable state", t => {
  const { memory } = createMemory(t, { maxMessages: 3 });
  const content = { details: { value: 1 } };
  const added = memory.addMessage("session-copy", "user", content);
  content.details.value = 2;
  added.messages[0].content = "mutated result";
  added.messages.push({ role: "assistant", content: "injected" });

  const session = memory.getOrCreate("session-copy");
  assert.deepEqual(session.messages, [
    { role: "user", content: '{"details":{"value":1}}', ts: session.messages[0].ts },
  ]);

  session.messages[0].content = "mutated session";
  session.updatedAt = "invalid";
  assert.deepEqual(memory.getOrCreate("session-copy"), {
    id: "session-copy",
    createdAt: session.createdAt,
    updatedAt: added.updatedAt,
    messages: [
      { role: "user", content: '{"details":{"value":1}}', ts: added.messages[0].ts },
    ],
  });
});

test("invalid direct memory limits use safe defaults", t => {
  const { storageDir } = createMemory(t);
  const memory = new ConversationMemory(storageDir, {
    maxMessages: "3abc",
    ttlHours: Infinity,
  });
  t.after(() => memory.destroy());

  assert.equal(memory.maxMessages, 50);
  assert.equal(memory.ttlHours, 24);
});

test("loads persisted sessions and supports clear and delete", t => {
  const { memory, storageDir } = createMemory(t);
  memory.addMessage("session/a", "user", "hello");
  const persistedFiles = fs.readdirSync(storageDir);
  assert.equal(persistedFiles.length, 1);
  assert.match(persistedFiles[0], /^[a-f0-9]{64}\.json$/);

  const restored = new ConversationMemory(storageDir);
  t.after(() => restored.destroy());
  assert.equal(restored.getSummary("session/a"), "Historique récent:\nU: hello");

  restored.clear("session/a");
  assert.equal(restored.getSummary("session/a"), "");
  assert.equal(restored.list()[0].count, 0);

  restored.addMessage("session/a", "assistant", "goodbye");
  restored.delete("session/a");
  assert.deepEqual(restored.list(), []);
  assert.deepEqual(fs.readdirSync(storageDir), []);
});

test("distinct session ids cannot collide on disk and legacy filenames remain deletable", t => {
  const { memory, storageDir } = createMemory(t);
  memory.addMessage("session/a", "user", "slash session");
  memory.addMessage("session_a", "user", "underscore session");

  const restored = new ConversationMemory(storageDir);
  t.after(() => restored.destroy());
  assert.equal(restored.list().length, 2);
  assert.equal(restored.getSummary("session/a"), "Historique récent:\nU: slash session");
  assert.equal(restored.getSummary("session_a"), "Historique récent:\nU: underscore session");

  const legacySession = {
    id: "legacy/session",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [{ role: "user", content: "legacy data", ts: new Date().toISOString() }],
  };
  const legacyFile = path.join(storageDir, "legacy_session.json");
  fs.writeFileSync(legacyFile, JSON.stringify(legacySession), "utf8");

  const withLegacy = new ConversationMemory(storageDir);
  t.after(() => withLegacy.destroy());
  assert.equal(withLegacy.getSummary("legacy/session"), "Historique récent:\nU: legacy data");
  withLegacy.delete("legacy/session");
  assert.equal(fs.existsSync(legacyFile), false);
});

test("loaded sessions enforce message limits and discard malformed persisted entries", t => {
  const { memory, storageDir } = createMemory(t, { maxMessages: 3 });
  const timestamp = new Date().toISOString();
  const session = {
    id: "oversized",
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [
      { role: "user", content: "first", ts: timestamp },
      { role: "assistant", content: "second", ts: timestamp },
      { role: "user", content: "malformed", ts: 42 },
      { role: "assistant", content: "third", ts: timestamp },
      { role: "user", content: "fourth", ts: timestamp },
      { role: "assistant", content: "fifth", ts: timestamp },
    ],
  };
  fs.writeFileSync(path.join(storageDir, "oversized.json"), JSON.stringify(session), "utf8");
  fs.writeFileSync(path.join(storageDir, "invalid.json"), JSON.stringify({
    id: "invalid",
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: {},
  }), "utf8");

  const restored = new ConversationMemory(storageDir, { maxMessages: 3 });
  t.after(() => restored.destroy());

  assert.deepEqual(
    restored.getOrCreate("oversized").messages.map(message => message.content),
    ["first", "fourth", "fifth"],
  );
  assert.equal(restored.getSummary("oversized"), "Historique récent:\nU: first\nU: fourth\nA: fifth");
  assert.equal(restored.list().some(entry => entry.id === "invalid"), false);
  assert.equal(restored.getOrCreate("invalid").id, "invalid");
  assert.deepEqual(restored.getOrCreate("invalid").messages, []);

  const persisted = JSON.parse(fs.readFileSync(restored._filePath("oversized"), "utf8"));
  assert.deepEqual(persisted.messages.map(message => message.content), ["first", "fourth", "fifth"]);
});

test("purges only sessions whose update time exceeds the configured TTL", t => {
  const { memory } = createMemory(t, { ttlHours: 1 });
  memory.addMessage("fresh", "user", "current");
  memory.addMessage("expired", "user", "old");

  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  memory._cache.get("expired").updatedAt = new Date(cutoff).toISOString();
  memory._persist(memory._cache.get("expired"));

  assert.equal(memory.purgeExpired(), 1);
  assert.deepEqual(memory.list().map(session => session.id), ["fresh"]);
});
