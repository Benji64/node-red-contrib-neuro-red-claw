"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ExperimentReportStore } = require("../../lib/experiment-report-store");

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "redclaw-experiment-reports-"));
}

function report(overrides = {}) {
  return {
    experiment_id: "experiment-1",
    configuration_version: "config-v1",
    status: "completed",
    runs: [{ case_id: "case-1", output: "result" }],
    comparisons: [],
    ...overrides,
  };
}

test("persists reports and returns isolated copies across store instances", t => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ExperimentReportStore(directory);
  const source = report();
  const appended = store.append(source);

  source.runs[0].output = "changed after append";
  appended.report.runs[0].output = "changed returned copy";
  assert.equal(store.list()[0].report.runs[0].output, "result");

  const reopenedStore = new ExperimentReportStore(directory);
  assert.equal(reopenedStore.list().length, 1);
  assert.equal(reopenedStore.list()[0].report.runs[0].output, "result");
  assert.ok(Number.isFinite(Date.parse(reopenedStore.list()[0].stored_at)));
});

test("rejects invalid report shapes and non-JSON values before writing", t => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ExperimentReportStore(directory);

  assert.throws(() => store.append(report({ status: "failed" })), /invalid shape/);
  assert.throws(() => store.append(report({ runs: [Number.NaN] })),
    /only JSON-compatible values/);
  assert.throws(() => new ExperimentReportStore(""), /storageDir must be a non-empty path/);
  assert.deepEqual(store.list(), []);
});

test("rejects inconsistent version metadata before writing", t => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ExperimentReportStore(directory);

  assert.throws(() => store.append(report({
    version_metadata: {
      status: "complete",
      required_fields: ["configuration_version"],
      missing_by_run: [{
        run_id: "run-1",
        case_id: "case-1",
        variant_id: "tree",
        missing_fields: ["model_version"],
      }],
    },
  })), /invalid version metadata/);
  assert.deepEqual(store.list(), []);
});

test("derives version metadata consistency from the persisted run labels", t => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ExperimentReportStore(directory);
  const completeVersionMetadata = {
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
  };
  const run = {
    experiment_id: "experiment-1",
    run_id: "run-1",
    case_id: "case-1",
    variant_id: "tree",
    run: {
      configuration_version: "cfg-1",
      prompt_version: "prompt-1",
      model_version: "model-1",
      policy_version: "policy-1",
      context_version: "context-1",
      contract_version: "contract-1",
    },
  };

  store.append(report({
    runs: [run],
    version_metadata: completeVersionMetadata,
  }));
  assert.throws(() => store.append(report({
    runs: [{ ...run, run: { ...run.run, model_version: null } }],
    version_metadata: completeVersionMetadata,
  })), /does not match its runs/);
  assert.throws(() => store.append(report({
    runs: [run],
    version_metadata: {
      ...completeVersionMetadata,
      required_fields: ["configuration_version"],
    },
  })), /invalid version metadata/);
  assert.equal(store.list().length, 1);
});

test("rejects inconsistent status counts in reports before writing", t => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ExperimentReportStore(directory);
  const statusCounts = {
    completed: 1,
    partial: 0,
    failed: 0,
    no_viable_candidate: 0,
    cancelled: 0,
    timeout: 0,
    budget_exceeded: 0,
    scoring_failed: 0,
  };
  const comparison = {
    variant_id: "baseline",
    failed_runs: 0,
    status_counts: statusCounts,
  };
  const run = {
    variant_id: "baseline",
    status: "completed",
  };

  store.append(report({
    runs: [run],
    comparisons: [comparison],
  }));
  assert.throws(() => store.append(report({
    runs: [run],
    comparisons: [{
      ...comparison,
      status_counts: { ...statusCounts, completed: 0, partial: 1 },
    }],
  })), /status counts do not match its runs/);
  assert.throws(() => store.append(report({
    runs: [{ ...run, status: "timeout" }],
    comparisons: [comparison],
  })), /status counts do not match its runs/);
  assert.equal(store.list().length, 1);
});

test("loads version 2 reports without dataset fingerprints", t => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ExperimentReportStore(directory);
  const run = {
    experiment_id: "experiment-1",
    run_id: "run-1",
    case_id: "case-1",
    variant_id: "baseline",
    status: "completed",
    score: {
      accuracy: true,
      quality: 1,
      success: true,
    },
    run: {
      experiment_id: "experiment-1",
      run_id: "run-1",
      configuration_version: "cfg-1",
      status: "completed",
      prompt_version: "prompt-1",
      model_version: "model-1",
      policy_version: "policy-1",
      context_version: "context-1",
      contract_version: "contract-1",
    },
  };
  const versionMetadata = {
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
  };
  const statusCounts = {
    completed: 1,
    partial: 0,
    failed: 0,
    no_viable_candidate: 0,
    cancelled: 0,
    timeout: 0,
    budget_exceeded: 0,
    scoring_failed: 0,
  };
  const comparison = {
    variant_id: "baseline",
    failed_runs: 0,
    status_counts: statusCounts,
  };
  const validV2Report = {
    ...report({
      configuration_version: "cfg-1",
      runs: [run],
      comparisons: [comparison],
      version_metadata: versionMetadata,
    }),
    schema_version: 2,
  };

  store.append(validV2Report);
  assert.throws(() => store.append({
    ...validV2Report,
    comparisons: [{ variant_id: "baseline", failed_runs: 0 }],
  }), /version 2 experiment report is incomplete/);
  assert.throws(() => store.append({
    ...validV2Report,
    runs: [{ ...run, status: "unknown" }],
  }), /version 2 experiment report is incomplete/);
  assert.throws(() => store.append({
    ...validV2Report,
    runs: [{ ...run, experiment_id: "other-experiment" }],
  }), /version 2 experiment report is incomplete/);
  assert.throws(() => store.append({
    ...validV2Report,
    configuration_version: "other-config",
  }), /version 2 experiment report is incomplete/);
  assert.throws(() => store.append({
    ...validV2Report,
    comparisons: [{ ...comparison, variant_id: "other" }],
  }), /inconsistent variant IDs/);
  assert.throws(() => store.append({
    ...validV2Report,
    schema_version: 3,
  }), /version 3 experiment report is incomplete/);
  assert.equal(store.list().length, 1);

  const restored = new ExperimentReportStore(directory);
  assert.equal(restored.list().length, 1);
  assert.equal(restored.list()[0].report.schema_version, 2);
});

test("requires dataset fingerprints in version 3 reports", t => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ExperimentReportStore(directory);
  const run = {
    experiment_id: "experiment-1",
    run_id: "run-1",
    case_id: "case-1",
    variant_id: "baseline",
    status: "completed",
    score: {
      accuracy: true,
      quality: 1,
      success: true,
    },
    run: {
      experiment_id: "experiment-1",
      run_id: "run-1",
      configuration_version: "cfg-1",
      status: "completed",
      prompt_version: "prompt-1",
      model_version: "model-1",
      policy_version: "policy-1",
      context_version: "context-1",
      contract_version: "contract-1",
    },
  };
  const validV3Report = {
    schema_version: 3,
    case_count: 1,
    dataset_digest: `sha256:${"b".repeat(64)}`,
    ...report({
      configuration_version: "cfg-1",
      runs: [run],
      comparisons: [{
        variant_id: "baseline",
        failed_runs: 0,
        scored_runs: 1,
        unscored_runs: 0,
        accuracy: 1,
        quality: 1,
        success_rate: 1,
        status_counts: {
          completed: 1,
          partial: 0,
          failed: 0,
          no_viable_candidate: 0,
          cancelled: 0,
          timeout: 0,
          budget_exceeded: 0,
          scoring_failed: 0,
        },
      }],
      version_metadata: {
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
      },
    }),
  };

  store.append(validV3Report);
  assert.throws(() => store.append({
    ...validV3Report,
    dataset_digest: "not-a-digest",
  }), /version 3 experiment report is incomplete/);
  assert.throws(() => store.append({
    ...validV3Report,
    case_count: 0,
  }), /version 3 experiment report is incomplete/);
  assert.throws(() => store.append({
    ...validV3Report,
    comparisons: [{
      ...validV3Report.comparisons[0],
      success_rate: 0,
    }],
  }), /score aggregates do not match its runs/);
  assert.throws(() => store.append({
    ...validV3Report,
    runs: [{ ...run, score: { ...run.score, quality: 2 } }],
  }), /score aggregates do not match its runs/);
  const runWithoutScore = { ...run };
  delete runWithoutScore.score;
  assert.throws(() => store.append({
    ...validV3Report,
    runs: [runWithoutScore],
  }), /score aggregates do not match its runs/);
  assert.throws(() => store.append({
    ...validV3Report,
    runs: [{ ...run, status: "timeout", run: { ...run.run, status: "timeout" } }],
    comparisons: [{
      ...validV3Report.comparisons[0],
      failed_runs: 1,
      status_counts: {
        completed: 0,
        partial: 0,
        failed: 0,
        no_viable_candidate: 0,
        cancelled: 0,
        timeout: 1,
        budget_exceeded: 0,
        scoring_failed: 0,
      },
    }],
  }), /score aggregates do not match its runs/);
  assert.throws(() => store.append({
    ...validV3Report,
    runs: [{ ...run, run_id: "" }],
  }), /version 2 experiment report is incomplete/);
  assert.throws(() => store.append({
    ...validV3Report,
    runs: [{ ...run, run: { ...run.run, status: "failed" } }],
  }), /version 2 experiment report is incomplete/);
  assert.throws(() => store.append({
    ...validV3Report,
    runs: [{ ...run, run: { ...run.run, run_id: "different-run" } }],
  }), /version 2 experiment report is incomplete/);
  assert.throws(() => store.append({
    ...validV3Report,
    runs: [run, {
      ...run,
      run_id: "run-2",
      run: { ...run.run, run_id: "run-2" },
    }],
  }), /version 2 experiment report is incomplete/);
  assert.throws(() => store.append({
    ...validV3Report,
    runs: [run, {
      ...run,
      run_id: "run-2",
      case_id: "case-2",
      run: { ...run.run, run_id: "run-2" },
    }],
  }), /version 3 experiment report is incomplete/);
  assert.throws(() => store.append({
    ...validV3Report,
    comparisons: [
      validV3Report.comparisons[0],
      {
        ...validV3Report.comparisons[0],
        variant_id: "tree",
        status_counts: { ...validV3Report.comparisons[0].status_counts, completed: 0 },
      },
    ],
  }), /incomplete variant coverage/);
  assert.doesNotThrow(() => store.append({
    ...validV3Report,
    status: "cancelled",
    runs: [],
    comparisons: [{
      ...validV3Report.comparisons[0],
      scored_runs: 0,
      unscored_runs: 0,
      accuracy: null,
      quality: null,
      success_rate: null,
      status_counts: {
        completed: 0,
        partial: 0,
        failed: 0,
        no_viable_candidate: 0,
        cancelled: 0,
        timeout: 0,
        budget_exceeded: 0,
        scoring_failed: 0,
      },
    }],
    version_metadata: {
      status: "unavailable",
      required_fields: validV3Report.version_metadata.required_fields,
      missing_by_run: [],
    },
  }));
  assert.equal(store.list().length, 2);
  assert.throws(() => store.append({
    ...validV3Report,
    schema_version: 4,
  }), /invalid shape/);
  const restored = new ExperimentReportStore(directory);
  assert.equal(restored.list()[0].report.schema_version, 3);
});

test("reports malformed and structurally invalid journal lines", t => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journal = path.join(directory, "experiment-reports.jsonl");
  fs.writeFileSync(journal, "{\"stored_at\":\"2026-10-19T00:00:00.000Z\"}\nnot-json\n", "utf8");

  assert.throws(
    () => new ExperimentReportStore(directory),
    /invalid experiment report journal record at line 1/,
  );

  fs.writeFileSync(journal,
    "{\"stored_at\":\"2026-10-19T00:00:00.000Z\",\"report\":{}}\n", "utf8");
  assert.throws(
    () => new ExperimentReportStore(directory),
    /invalid experiment report journal record at line 1: experiment report has an invalid shape/,
  );
});

test("surfaces malformed JSON journal records with the exact line", t => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journal = path.join(directory, "experiment-reports.jsonl");
  fs.writeFileSync(journal, `${JSON.stringify({
    stored_at: "2026-10-19T00:00:00.000Z",
    report: report(),
  })}\nnot-json\n`, "utf8");

  assert.throws(
    () => new ExperimentReportStore(directory),
    /invalid experiment report journal at line 2/,
  );
});
