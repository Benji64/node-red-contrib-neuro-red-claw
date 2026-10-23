const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Instrumentation } = require("../../lib/instrumentation");
const { runExperiment } = require("../../lib/experiment-framework");
const { ExperimentReportStore } = require("../../lib/experiment-report-store");

function experimentOptions(overrides = {}) {
  return {
    experimentId: "stored-experiment",
    configurationVersion: "cfg-1",
    cases: [{ id: "case-1", input: { value: 1 }, expected: 1 }],
    variants: [
      { id: "baseline", type: "baseline", run: async ({ input }) => ({ output: input.value }) },
      { id: "tree", type: "tree", run: async ({ input }) => ({ output: input.value }) },
    ],
    score: async ({ expected, output }) => ({
      accuracy: output === expected,
      quality: output === expected ? 1 : 0,
      success: output === expected,
    }),
    instrumentation: new Instrumentation(),
    ...overrides,
  };
}

test("supports the four required paired experiment modes", async () => {
  const types = ["baseline", "linear", "tree", "tree_confrontation"];
  const report = await runExperiment(experimentOptions({
    experimentId: "required-mode-comparison",
    cases: [{ id: "case-1", input: { value: "fixture" }, expected: "fixture" }],
    variants: types.map(type => ({
      id: type,
      type,
      run: async ({ input }) => ({ output: input.value }),
    })),
  }));

  assert.equal(report.status, "completed");
  assert.deepEqual(report.comparisons.map(comparison => comparison.variant_id), types);
  assert.ok(report.comparisons.every(comparison =>
    comparison.quality === 1 && comparison.success_rate === 1
  ));
  assert.ok(report.comparisons.slice(1).every(comparison =>
    comparison.delta_vs_baseline.quality === 0
  ));
});

test("persists experiment reports append-only and reloads them for export", async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-experiment-reports-"));
  try {
    const store = new ExperimentReportStore(storageDir);
    const report = await runExperiment(experimentOptions({ reportStore: store }));

    assert.equal(report.status, "completed");
    assert.equal(store.list().length, 1);
    assert.deepEqual(store.list()[0].report, report);
    assert.ok(Date.parse(store.list()[0].stored_at));

    const reloaded = new ExperimentReportStore(storageDir);
    assert.deepEqual(reloaded.list(), store.list());

    await runExperiment(experimentOptions({
      experimentId: "stored-experiment-repeat",
      reportStore: reloaded,
    }));
    assert.equal(reloaded.list().length, 2);
    assert.equal(fs.readFileSync(
      path.join(storageDir, "experiment-reports.jsonl"),
      "utf8"
    ).trim().split(/\r?\n/).length, 2);
  } finally {
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
});

test("surfaces report-store errors instead of returning an unpersisted success", async () => {
  await assert.rejects(
    runExperiment(experimentOptions({
      reportStore: { append() { throw new Error("disk unavailable"); } },
    })),
    /disk unavailable/,
  );
});

test("rejects malformed persisted report records", () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-experiment-reports-invalid-"));
  try {
    fs.writeFileSync(
      path.join(storageDir, "experiment-reports.jsonl"),
      `${JSON.stringify({ stored_at: "2026-10-19T00:00:00.000Z", report: { experiment_id: "bad" } })}\n`,
      "utf8",
    );
    assert.throws(() => new ExperimentReportStore(storageDir), /invalid experiment report journal record/);
  } finally {
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
});

test("compares paired variants using score, cost, tree, safety, and intervention metrics", async () => {
  const instrumentation = new Instrumentation(10);
  const result = await runExperiment({
    experimentId: "fixture-comparison",
    configurationVersion: "cfg-1",
    hypothesis: "Tree reasoning may improve accuracy on this fixture",
    cases: [
      { id: "case-1", input: { value: 2 }, expected: 4 },
      { id: "case-2", input: { value: 3 }, expected: 6 },
    ],
    variants: [
      {
        id: "baseline",
        type: "baseline",
        metadata: { model: "fixture-model", model_version: "v1" },
        run: async ({ input }) => ({
          output: input.value * 2,
          usage: { tokens: 3, cost: 0.01 },
        }),
      },
      {
        id: "tree",
        type: "tree",
        run: async ({ input, onEvent }) => {
          onEvent({
            type: "branch_created",
            nodeId: "child",
            parentId: "root",
            branchId: "branch",
            depth: 2,
            cognitiveRole: "reasoning",
          });
          onEvent({ type: "branch_pruned", depth: 2 });
          onEvent({ type: "branch_evaluated", confidence: 0.75 });
          onEvent({ type: "contradiction_found" });
          return {
            output: input.value === 2 ? 4 : -1,
            usage: { tokens: 5, cost: 0.02 },
            safety_decision: "review",
            human_validation: true,
          };
        },
      },
    ],
    score: async ({ expected, output }) => ({
      accuracy: output === expected,
      quality: output === expected ? 1 : 0.5,
      success: output === expected,
    }),
    instrumentation,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.runs.length, 4);
  assert.equal(result.version_metadata.status, "incomplete");
  assert.ok(result.version_metadata.missing_by_run.some(row =>
    row.variant_id === "tree" && row.missing_fields.includes("model_version")
  ));
  assert.equal(result.runs[0].run.experiment_id, "fixture-comparison");
  assert.ok(result.runs.every(run => run.run_id && run.run.request_id));

  const baseline = result.comparisons.find(row => row.variant_id === "baseline");
  const tree = result.comparisons.find(row => row.variant_id === "tree");
  assert.equal(baseline.accuracy, 1);
  assert.equal(baseline.quality, 1);
  assert.equal(baseline.success_rate, 1);
  assert.equal(baseline.tokens, 6);
  assert.equal(baseline.cost, 0.02);
  assert.equal(tree.accuracy, 0.5);
  assert.equal(tree.quality, 0.75);
  assert.equal(tree.success_rate, 0.5);
  assert.equal(tree.tree_depth, 2);
  assert.equal(tree.branch_count, 2);
  assert.equal(tree.pruned_branches, 2);
  assert.equal(tree.confidence, 0.75);
  assert.equal(tree.contradiction_count, 2);
  assert.equal(tree.safety_interventions, 2);
  assert.equal(tree.human_interventions, 2);
  assert.equal(tree.delta_vs_baseline.quality, -0.25);
  assert.equal(tree.delta_vs_baseline.tokens, 4);
  assert.deepEqual(tree.paired_delta_vs_baseline.quality, {
    n: 2,
    mean: -0.25,
    standard_error: 0.25,
  });
  assert.deepEqual(tree.paired_delta_vs_baseline.accuracy, {
    n: 2,
    mean: -0.5,
    standard_error: 0.5,
  });
  assert.equal(tree.paired_delta_vs_baseline.tokens.mean, 2);
  assert.equal(instrumentation.recentRuns().length, 4);
});

test("reports complete version metadata only when every run supplies required labels", async () => {
  const versionMetadata = {
    configuration_version: "cfg-1",
    prompt_version: "prompt-1",
    model_version: "model-1",
    policy_version: "policy-1",
    context_version: "context-1",
    contract_version: "contract-1",
  };
  const result = await runExperiment({
    experimentId: "fully-versioned-experiment",
    configurationVersion: versionMetadata.configuration_version,
    cases: [{ id: "case-1", input: {} }],
    variants: [
      {
        id: "baseline",
        type: "baseline",
        metadata: versionMetadata,
        run: async () => ({ output: "baseline" }),
      },
      {
        id: "tree",
        type: "tree",
        metadata: versionMetadata,
        run: async () => ({ output: "tree" }),
      },
    ],
    score: async () => ({ quality: 1, success: true }),
    instrumentation: new Instrumentation(),
  });

  assert.deepEqual(result.version_metadata, {
    status: "complete",
    required_fields: [
      "configuration_version",
      "prompt_version",
      "model_version",
      "policy_version",
      "context_version",
      "contract_version",
    ],
    missing_by_run: [],
  });
});

test("records failed variants and rejects invalid experiment contracts", async () => {
  const result = await runExperiment({
    experimentId: "failure-fixture",
    configurationVersion: "cfg-1",
    cases: [{ id: "case-1", input: {}, expected: null }],
    variants: [
      { id: "baseline", type: "baseline", run: async () => { throw new Error("provider unavailable"); } },
      { id: "linear", type: "linear", run: async () => ({ output: null }) },
    ],
    score: async () => ({ accuracy: true, quality: 1, success: true }),
    instrumentation: new Instrumentation(),
  });

  assert.equal(result.runs[0].status, "failed");
  assert.equal(result.runs[0].error, "provider unavailable");
  assert.equal(result.runs[0].run.status, "failed");
  assert.equal(result.runs[1].status, "completed");
  assert.equal(result.version_metadata.status, "incomplete");

  await assert.rejects(
    runExperiment({
      experimentId: "missing-baseline",
      configurationVersion: "cfg-1",
      cases: [{ id: "case-1", input: {} }],
      variants: [
        { id: "linear", type: "linear", run: async () => ({ output: null }) },
        { id: "tree", type: "tree", run: async () => ({ output: null }) },
      ],
      score: async () => ({ quality: 1, success: true }),
    }),
    /baseline variant is required/,
  );
});

test("accepts known reasoning statuses and fails unknown variant statuses explicitly", async () => {
  const result = await runExperiment({
    experimentId: "variant-status-validation",
    configurationVersion: "cfg-1",
    cases: [{ id: "case-1", input: {} }],
    variants: [
      {
        id: "baseline",
        type: "baseline",
        run: async () => ({ output: "baseline", status: "completed" }),
      },
      {
        id: "tree",
        type: "tree",
        run: async () => ({ output: "tree", status: "partial" }),
      },
    ],
    score: async () => ({ quality: 0.5, success: false }),
    instrumentation: new Instrumentation(),
  });
  assert.equal(result.runs[0].status, "completed");
  assert.equal(result.runs[1].status, "partial");
  assert.equal(result.runs[1].run.status, "partial");
  assert.equal(result.comparisons[1].failed_runs, 0);
  assert.deepEqual(result.comparisons[1].status_counts, {
    completed: 0,
    partial: 1,
    failed: 0,
    no_viable_candidate: 0,
    cancelled: 0,
    timeout: 0,
    budget_exceeded: 0,
    scoring_failed: 0,
  });

  const timeout = await runExperiment({
    experimentId: "variant-timeout-status",
    configurationVersion: "cfg-1",
    cases: [{ id: "case-1", input: {} }],
    variants: [
      { id: "baseline", type: "baseline", run: async () => ({ output: null }) },
      { id: "tree", type: "tree", run: async () => ({ output: null, status: "timeout" }) },
    ],
    score: async () => ({ quality: 1, success: true }),
    instrumentation: new Instrumentation(),
  });
  const timeoutComparison = timeout.comparisons.find(row => row.variant_id === "tree");
  assert.equal(timeoutComparison.status_counts.timeout, 1);
  assert.equal(timeoutComparison.failed_runs, 1);
  assert.equal(timeout.runs[1].score, null);
  assert.equal(timeoutComparison.success_rate, null);
  assert.equal(timeoutComparison.scored_runs, 0);
  assert.equal(timeoutComparison.unscored_runs, 1);

  const invalid = await runExperiment({
    experimentId: "invalid-variant-status",
    configurationVersion: "cfg-1",
    cases: [{ id: "case-1", input: {} }],
    variants: [
      { id: "baseline", type: "baseline", run: async () => ({ output: null }) },
      { id: "tree", type: "tree", run: async () => ({ output: null, status: "done-ish" }) },
    ],
    score: async () => ({ quality: 1, success: true }),
    instrumentation: new Instrumentation(),
  });

  assert.equal(invalid.runs[1].status, "failed");
  assert.match(invalid.runs[1].error, /unsupported status.*done-ish/);
  assert.equal(invalid.runs[1].run.status, "failed");
});

test("does not score failed or budget-exceeded variant results", async () => {
  let scoreCalls = 0;
  const result = await runExperiment({
    experimentId: "unscored-interrupted-variants",
    configurationVersion: "cfg-1",
    cases: [{ id: "case-1", input: {} }],
    variants: [
      { id: "baseline", type: "baseline", run: async () => ({ output: "baseline" }) },
      { id: "tree", type: "tree", run: async () => ({ output: "partial-output", status: "budget_exceeded" }) },
    ],
    score: async () => {
      scoreCalls++;
      return { quality: 1, success: true };
    },
    instrumentation: new Instrumentation(),
  });

  assert.equal(scoreCalls, 1);
  assert.equal(result.runs[1].status, "budget_exceeded");
  assert.equal(result.runs[1].score, null);
  const treeComparison = result.comparisons.find(row => row.variant_id === "tree");
  assert.equal(treeComparison.success_rate, null);
  assert.equal(treeComparison.scored_runs, 0);
  assert.equal(treeComparison.unscored_runs, 1);
  assert.equal(treeComparison.failed_runs, 1);
});

test("keeps scoring failures explicit and validates measured scores", async () => {
  const result = await runExperiment({
    experimentId: "score-failure",
    configurationVersion: "cfg-1",
    cases: [{ id: "case-1", input: {} }],
    variants: [
      { id: "baseline", type: "baseline", run: async () => ({ output: "result" }) },
      { id: "tree", type: "tree", run: async () => ({ output: "result" }) },
    ],
    score: async () => ({ quality: 1.5, success: true }),
    instrumentation: new Instrumentation(),
  });

  assert.equal(result.runs[0].status, "scoring_failed");
  assert.match(result.runs[0].error, /quality must be between 0 and 1/);
  assert.equal(result.runs[0].run.status, "scoring_failed");
  assert.match(result.runs[0].run.outcome.error, /quality must be between 0 and 1/);
  assert.equal(result.comparisons[0].failed_runs, 1);
});

test("records scoring-triggered cancellation in the cognitive run", async () => {
  const controller = new AbortController();
  const result = await runExperiment({
    experimentId: "cancelled-during-scoring",
    configurationVersion: "cfg-1",
    cases: [{ id: "case-1", input: {} }],
    variants: [
      { id: "baseline", type: "baseline", run: async () => ({ output: "result" }) },
      { id: "tree", type: "tree", run: async () => ({ output: "result" }) },
    ],
    score: async () => {
      controller.abort();
      throw new Error("scoring interrupted");
    },
    instrumentation: new Instrumentation(),
    signal: controller.signal,
  });

  assert.equal(result.status, "cancelled");
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].status, "cancelled");
  assert.equal(result.runs[0].run.status, "cancelled");
  assert.match(result.runs[0].error, /scoring interrupted/);
});

test("discards a score returned after cancellation during scoring", async () => {
  const controller = new AbortController();
  const result = await runExperiment({
    experimentId: "cancelled-after-score",
    configurationVersion: "cfg-1",
    cases: [{ id: "case-1", input: {} }],
    variants: [
      { id: "baseline", type: "baseline", run: async () => ({ output: "result" }) },
      { id: "tree", type: "tree", run: async () => ({ output: "result" }) },
    ],
    score: async () => {
      controller.abort();
      return { quality: 1, success: true };
    },
    instrumentation: new Instrumentation(),
    signal: controller.signal,
  });

  assert.equal(result.status, "cancelled");
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].status, "cancelled");
  assert.equal(result.runs[0].score, null);
  const comparison = result.comparisons.find(row => row.variant_id === "baseline");
  assert.equal(comparison.scored_runs, 0);
  assert.equal(comparison.unscored_runs, 1);
  assert.equal(comparison.success_rate, null);
});

test("marks cancellation during the final variant even if that variant returns", async () => {
  const controller = new AbortController();
  const result = await runExperiment({
    experimentId: "cancelled-run",
    configurationVersion: "cfg-1",
    cases: [{ id: "case-1", input: {} }],
    variants: [
      { id: "baseline", type: "baseline", run: async () => ({ output: null }) },
      {
        id: "tree",
        type: "tree",
        run: async () => {
          controller.abort();
          return { output: null };
        },
      },
    ],
    score: async () => ({ quality: 1, success: true }),
    instrumentation: new Instrumentation(),
    signal: controller.signal,
  });

  assert.equal(result.status, "cancelled");
  assert.equal(result.runs.length, 2);
});

test("rejects non-JSON values instead of silently normalizing experiment inputs", async () => {
  await assert.rejects(
    runExperiment({
      experimentId: "invalid-input",
      configurationVersion: "cfg-1",
      cases: [{ id: "case-1", input: { value: Number.NaN } }],
      variants: [
        { id: "baseline", type: "baseline", run: async () => ({ output: null }) },
        { id: "tree", type: "tree", run: async () => ({ output: null }) },
      ],
      score: async () => ({ quality: 1, success: true }),
    }),
    /JSON-compatible values/,
  );
});

test("uses a recorded seed for reproducible paired order and per-run random seeds", async () => {
  async function execute() {
    const order = [];
    const seeds = new Map();
    const result = await runExperiment({
      experimentId: "seeded-comparison",
      configurationVersion: "cfg-1",
      seed: "experiment-seed-42",
      cases: [
        { id: "case-1", input: { value: 1 } },
        { id: "case-2", input: { value: 2 } },
      ],
      variants: [
        { id: "baseline", type: "baseline", run: async ({ caseId, seed }) => {
          order.push(`${caseId}:baseline`);
          seeds.set(`${caseId}:baseline`, seed);
          return { output: null };
        } },
        { id: "linear", type: "linear", run: async ({ caseId, seed }) => {
          order.push(`${caseId}:linear`);
          seeds.set(`${caseId}:linear`, seed);
          return { output: null };
        } },
        { id: "tree", type: "tree", run: async ({ caseId, seed }) => {
          order.push(`${caseId}:tree`);
          seeds.set(`${caseId}:tree`, seed);
          return { output: null };
        } },
      ],
      score: async () => ({ quality: 1, success: true }),
      instrumentation: new Instrumentation(),
    });
    return { result, order, seeds };
  }

  const first = await execute();
  const second = await execute();
  assert.deepEqual(first.order, second.order);
  assert.deepEqual([...first.seeds], [...second.seeds]);
  assert.equal(first.result.seed, "experiment-seed-42");
  assert.ok(first.result.runs.every(row =>
    row.run.experiment_seed === first.seeds.get(`${row.case_id}:${row.variant_id}`)
  ));
  assert.deepEqual(first.order.slice(0, 3).sort(), ["case-1:baseline", "case-1:linear", "case-1:tree"]);
  assert.deepEqual(first.order.slice(3).sort(), ["case-2:baseline", "case-2:linear", "case-2:tree"]);
});

test("derives distinct run seeds when case and variant IDs contain separators", async () => {
  const seeds = new Map();
  await runExperiment({
    experimentId: "seed-separator-collision",
    configurationVersion: "cfg-1",
    seed: "experiment-seed",
    cases: [
      { id: "case", input: null },
      { id: "case:one", input: null },
    ],
    variants: [
      { id: "one:baseline", type: "baseline", run: async ({ caseId, seed }) => {
        seeds.set(`${caseId}\u0000one:baseline`, seed);
        return { output: null };
      } },
      { id: "baseline", type: "tree", run: async ({ caseId, seed }) => {
        seeds.set(`${caseId}\u0000baseline`, seed);
        return { output: null };
      } },
    ],
    score: async () => ({ quality: 1, success: true }),
    instrumentation: new Instrumentation(),
  });

  assert.equal(seeds.size, 4);
  assert.notEqual(seeds.get("case\u0000one:baseline"), seeds.get("case:one\u0000baseline"));
  assert.equal(new Set(seeds.values()).size, 4);
});

test("fingerprints case datasets canonically without depending on object key order", async () => {
  async function runCase(input, expected) {
    return runExperiment({
      experimentId: "dataset-fingerprint",
      configurationVersion: "cfg-1",
      cases: [{ id: "case-1", input, expected }],
      variants: [
        { id: "baseline", type: "baseline", run: async () => ({ output: "same" }) },
        { id: "tree", type: "tree", run: async () => ({ output: "same" }) },
      ],
      score: async () => ({ quality: 1, success: true }),
      instrumentation: new Instrumentation(),
    });
  }

  const first = await runCase({ alpha: 1, nested: { left: true, right: [1, 2] } }, "expected");
  const reorderedKeys = await runCase({ nested: { right: [1, 2], left: true }, alpha: 1 }, "expected");
  const changedDataset = await runCase({ alpha: 2, nested: { left: true, right: [1, 2] } }, "expected");
  const changedExpected = await runCase({ alpha: 1, nested: { left: true, right: [1, 2] } }, "other");

  assert.equal(first.case_count, 1);
  assert.equal(first.schema_version, 3);
  assert.match(first.dataset_digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.dataset_digest, reorderedKeys.dataset_digest);
  assert.notEqual(first.dataset_digest, changedDataset.dataset_digest);
  assert.notEqual(first.dataset_digest, changedExpected.dataset_digest);
});

test("paired summaries exclude unscored cases and report descriptive standard error", async () => {
  const result = await runExperiment({
    experimentId: "paired-failures",
    configurationVersion: "cfg-1",
    cases: [
      { id: "scored-1", input: {} },
      { id: "scored-2", input: {} },
      { id: "failed", input: {} },
    ],
    variants: [
      { id: "baseline", type: "baseline", run: async () => ({ output: "base" }) },
      { id: "tree", type: "tree", run: async ({ caseId }) => {
        if (caseId === "failed") throw new Error("fixture failure");
        return { output: caseId === "scored-1" ? "same" : "different" };
      } },
    ],
    score: async ({ variantId, output }) => ({
      accuracy: output === "same",
      quality: variantId === "baseline" ? 1 : output === "same" ? 1 : 0,
      success: output === "same",
    }),
    instrumentation: new Instrumentation(),
  });
  const tree = result.comparisons.find(row => row.variant_id === "tree");

  assert.deepEqual(tree.paired_delta_vs_baseline.quality, {
    n: 2,
    mean: -0.5,
    standard_error: 0.5,
  });
  assert.deepEqual(tree.paired_delta_vs_baseline.accuracy, {
    n: 2,
    mean: 0.5,
    standard_error: 0.5,
  });
  assert.equal(tree.paired_delta_vs_baseline.cost.n, 3);
  assert.equal(tree.paired_delta_vs_baseline.cost.standard_error, 0);
});
