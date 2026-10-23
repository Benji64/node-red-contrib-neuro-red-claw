#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { analyzeFlow } = require("../lib/cognitive-graph-analyzer");

const ROOT = path.join(__dirname, "..");
const DEFAULT_FLOW = path.join(ROOT, "examples", "cognitive-flow.json");
const RULES = [
  ["ruleE", "Flow structure and wiring"],
  ["ruleA", "Canonical decision boundary for reflection"],
  ["ruleB", "Decision policy and safety boundary"],
  ["ruleC", "Cycles with a verified timeout node"],
  ["ruleD", "Canonical tool authority"],
  ["ruleF", "Reasoning decision boundary"],
  ["ruleG", "Exclusive write ownership"],
  ["ruleH", "Responsibility uniqueness"],
  ["ruleI", "Category write boundaries"],
  ["ruleJ", "Reasoning convergence boundary"],
  ["ruleK", "Entry-to-execution decision boundary"],
];
const flowFiles = process.argv.slice(2).length
  ? process.argv.slice(2).map(file => path.resolve(process.cwd(), file))
  : [DEFAULT_FLOW];
let failed = false;

for (const file of flowFiles) {
  let flow;
  try {
    flow = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`FAIL ${file}: unable to read or parse JSON: ${error.message}`);
    failed = true;
    continue;
  }

  const result = analyzeFlow(flow);
  const report = result.ok ? console.log : console.error;
  report("COGNITIVE GRAPH ANALYSIS");
  report(`Flow: ${file}`);
  for (const [field, label] of RULES) {
    const violations = result[field] || [];
    const blockedByStructure = result.ruleE.length > 0 && field !== "ruleE";
    const skippedForCoverage = field === "ruleK" &&
      result.ruleKSkipped && result.ruleKSkipped.length > 0;
    const skipped = blockedByStructure || (!violations.length && skippedForCoverage);
    const status = skipped ? "SKIP" : violations.length ? "FAIL" : "PASS";
    let detail = "";
    if (blockedByStructure) {
      detail = " (blocked by invalid structure)";
    } else if (violations.length) {
      detail = ` (${violations.length} violation(s))`;
    }
    if (!blockedByStructure && field === "ruleK" && skippedForCoverage) {
      const coverageDetail =
        `execution entry coverage unknown: ${result.ruleKSkipped.join(", ")}`;
      detail = detail
        ? `${detail.slice(0, -1)}; ${coverageDetail})`
        : ` (${coverageDetail})`;
    }
    report(`  ${status}  ${label}${detail}`);
  }

  if (result.ok) {
    const hasSkippedChecks = result.ruleE.length > 0 ||
      (result.ruleKSkipped && result.ruleKSkipped.length > 0);
    console.log(`OK   ${file}${hasSkippedChecks ? " (some checks skipped)" : ""}`);
    continue;
  }

  console.error(`FAIL ${file}`);
  for (const violation of result.violations) {
    console.error(`  ${violation.message}`);
  }
  failed = true;
}

if (failed) process.exitCode = 1;
