"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const yaml = require("js-yaml");

const MAX_SKILL_FILE_BYTES = 128 * 1024;
const FRONTMATTER_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

function loadAgentSkill(rootDirectory, skillName) {
  if (typeof rootDirectory !== "string" || !rootDirectory.trim()) {
    throw new TypeError("Agent Skills root directory must be a non-empty path");
  }
  validateSkillName(skillName);

  const rootPath = resolveRealPath(rootDirectory, "Agent Skills root directory");
  const skillPath = path.resolve(rootPath, skillName);
  assertInside(rootPath, skillPath, "Skill directory");

  const realSkillPath = resolveRealPath(skillPath, "Skill directory");
  assertInside(rootPath, realSkillPath, "Skill directory");

  const filePath = resolveRealPath(path.join(realSkillPath, "SKILL.md"), "SKILL.md");
  assertInside(realSkillPath, filePath, "SKILL.md");

  const fileStat = fs.statSync(filePath);
  if (!fileStat.isFile()) throw new Error("SKILL.md must be a regular file");
  if (fileStat.size > MAX_SKILL_FILE_BYTES) {
    throw new Error(`SKILL.md exceeds the ${MAX_SKILL_FILE_BYTES}-byte limit`);
  }

  const source = fs.readFileSync(filePath);
  const skill = parseAgentSkill(source.toString("utf8"));
  if (skill.name !== skillName) {
    throw new Error(`SKILL.md name "${skill.name}" must match directory "${skillName}"`);
  }
  return { ...skill, sha256: createHash("sha256").update(source).digest("hex") };
}

function parseAgentSkill(source) {
  if (typeof source !== "string") throw new TypeError("SKILL.md content must be a string");
  const content = source.replace(/^\uFEFF/, "");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("SKILL.md must start with YAML frontmatter delimited by ---");

  let frontmatter;
  try {
    frontmatter = yaml.load(match[1]);
  } catch (error) {
    throw new Error(`SKILL.md frontmatter is invalid YAML: ${error.message}`, { cause: error });
  }
  if (!isRecord(frontmatter)) throw new Error("SKILL.md frontmatter must be a YAML mapping");

  for (const key of Object.keys(frontmatter)) {
    if (!FRONTMATTER_FIELDS.has(key)) {
      throw new Error(`SKILL.md frontmatter contains unsupported field "${key}"`);
    }
  }

  const name = validateSkillName(frontmatter.name);
  const description = requireString(frontmatter.description, "description", 1024);
  const license = optionalString(frontmatter.license, "license");
  const compatibility = optionalString(frontmatter.compatibility, "compatibility", 500);
  optionalString(frontmatter["allowed-tools"], "allowed-tools");
  const metadata = frontmatter.metadata === undefined ? {} : frontmatter.metadata;
  validateMetadata(metadata);

  const instructions = content.slice(match[0].length).trim();
  if (!instructions) throw new Error("SKILL.md must include Markdown instructions after its frontmatter");

  return { name, description, license, compatibility, metadata, instructions };
}

function validateSkillName(name) {
  if (typeof name !== "string" || name.length < 1 || name.length > 64 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error("Skill name must be 1-64 lowercase ASCII letters/digits separated by single hyphens");
  }
  return name;
}

function requireString(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`SKILL.md "${field}" must be a non-empty string of at most ${maxLength} characters`);
  }
  return value.trim();
}

function optionalString(value, field, maxLength = Infinity) {
  if (value === undefined) return "";
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`SKILL.md "${field}" must be a non-empty string` +
      (Number.isFinite(maxLength) ? ` of at most ${maxLength} characters` : ""));
  }
  return value.trim();
}

function validateMetadata(metadata) {
  if (!isRecord(metadata)) throw new Error('SKILL.md "metadata" must be a mapping of strings');
  for (const [key, value] of Object.entries(metadata)) {
    if (!key.trim() || typeof value !== "string") {
      throw new Error('SKILL.md "metadata" keys must be non-empty and values must be strings');
    }
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function resolveRealPath(value, label) {
  try {
    return fs.realpathSync(value);
  } catch (error) {
    throw new Error(`${label} could not be resolved: ${error.message}`, { cause: error });
  }
}

function assertInside(root, target, label) {
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside its allowed directory`);
  }
}

module.exports = {
  MAX_SKILL_FILE_BYTES,
  loadAgentSkill,
  parseAgentSkill,
};
