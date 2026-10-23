"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const {
  MAX_SKILL_FILE_BYTES,
  loadAgentSkill,
  parseAgentSkill,
} = require("../../lib/agent-skill");

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redclaw-agent-skills-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeSkill(root, name, contents) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), contents, "utf8");
}

test("loads validated Agent Skill metadata and instructions from SKILL.md", t => {
  const root = makeRoot(t);
  writeSkill(root, "code-review", `---
name: code-review
description: Review code changes and explain risks.
license: MIT
compatibility: Node-RED
metadata:
  author: team
  version: "1.0"
allowed-tools: Read
---
Inspect the changed files.

Report actionable findings.`);

  const loaded = loadAgentSkill(root, "code-review");
  assert.deepEqual(loaded, {
    name: "code-review",
    description: "Review code changes and explain risks.",
    license: "MIT",
    compatibility: "Node-RED",
    metadata: { author: "team", version: "1.0" },
    instructions: "Inspect the changed files.\n\nReport actionable findings.",
    sha256: createHash("sha256")
      .update(fs.readFileSync(path.join(root, "code-review", "SKILL.md")))
      .digest("hex"),
  });
});

test("parses UTF-8 BOM and Windows line endings", () => {
  const skill = parseAgentSkill("\uFEFF---\r\nname: writing\r\ndescription: Helps write documentation.\r\n---\r\nWrite clearly.\r\n");
  assert.equal(skill.name, "writing");
  assert.equal(skill.instructions, "Write clearly.");
});

test("rejects invalid names, missing required metadata, and directory-name mismatches", t => {
  const root = makeRoot(t);
  writeSkill(root, "code-review", `---
name: Code-Review
description: Review code.
---
Review changes.`);
  assert.throws(() => loadAgentSkill(root, "code-review"), /lowercase ASCII/);
  assert.throws(() => loadAgentSkill(root, "../outside"), /Skill name/);

  writeSkill(root, "another-skill", `---
name: writing
description: Helps write documentation.
---
Write clearly.`);
  assert.throws(() => loadAgentSkill(root, "another-skill"), /must match directory/);
  assert.throws(() => parseAgentSkill(`---
name: writing
---
Write clearly.`), /description/);
});

test("rejects malformed or unsupported frontmatter", () => {
  assert.throws(() => parseAgentSkill("---\nname: [\n---\ntext"), /invalid YAML/);
  assert.throws(() => parseAgentSkill("---\nname: writing\ndescription: Helps write.\nextra: true\n---\ntext"), /unsupported field/);
  assert.throws(() => parseAgentSkill("---\nname: writing\ndescription: Helps write.\nmetadata:\n  author: 7\n---\ntext"), /metadata/);
  assert.throws(() => parseAgentSkill("---\nname: writing\ndescription: Helps write.\n---\n"), /instructions/);
  const metadata = parseAgentSkill(`---
name: writing
description: Helps write.
metadata:
  note: ""
---
Write clearly.`).metadata;
  assert.deepEqual(metadata, { note: "" });
});

test("rejects a skill package linked outside the configured skills root", t => {
  const root = makeRoot(t);
  const outside = makeRoot(t);
  writeSkill(outside, "outside", `---
name: escape
description: Escapes the skills root.
---
Do not load this.`);
  try {
    fs.symlinkSync(path.join(outside, "outside"), path.join(root, "escape"), "junction");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip(`directory symlinks are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.throws(() => loadAgentSkill(root, "escape"), /inside its allowed directory/);
});

test("rejects missing and oversized SKILL.md files", t => {
  const root = makeRoot(t);
  fs.mkdirSync(path.join(root, "empty"));
  assert.throws(() => loadAgentSkill(root, "empty"), /could not be resolved/);

  const contents = `---\nname: large\ndescription: Large skill.\n---\n${"x".repeat(MAX_SKILL_FILE_BYTES)}`;
  writeSkill(root, "large", contents);
  assert.throws(() => loadAgentSkill(root, "large"), /exceeds the/);
});
