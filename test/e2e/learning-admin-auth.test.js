"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const bcrypt = require("bcryptjs");
const { LearningCandidateStore } = require("../../lib/learning-candidate-store");
const { buildLearningCandidates } = require("../../lib/learning-engine");

const CORE_DIR = path.join(__dirname, "..", "..");
const RED_JS = path.join(CORE_DIR, "node_modules", "node-red", "red.js");
const PORT = 21000 + Math.floor(Math.random() * 900);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = "redclaw-test-admin-password";
const READER_PASSWORD = "redclaw-test-reader-password";
const REVIEWER_PASSWORD = "redclaw-test-reviewer-password";

let processHandle;
let workDir;
let processOutput = "";
let candidateId;
let pendingCandidateId;
let settingsPath;
let userDir;

async function waitForServer() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
      throw new Error(`Node-RED exited before becoming ready:\n${processOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/auth/login`);
      if (response.ok) return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 200));
      continue;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Node-RED did not become ready:\n${processOutput}`);
}

async function startNodeRed() {
  processOutput = "";
  processHandle = spawn("node", [RED_JS, "--settings", settingsPath], {
    cwd: userDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  processHandle.stdout.on("data", chunk => { processOutput += chunk.toString(); });
  processHandle.stderr.on("data", chunk => { processOutput += chunk.toString(); });
  await waitForServer();
}

async function stopNodeRed() {
  if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  const child = processHandle;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill();
  await exited;
}

async function accessToken(username, password) {
  const response = await fetch(`${BASE_URL}/auth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from("node-red-editor:not_available").toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: "node-red-editor",
      client_secret: "not_available",
      grant_type: "password",
      username,
      password,
      scope: username === "redclaw-reader"
        ? "redclaw.learning.read"
        : username === "redclaw-reviewer" ? "redclaw.learning.review" : "*",
    }),
  });
  const responseText = await response.text();
  assert.equal(
    response.status,
    200,
    `token request failed (${response.status}): ${responseText}\n${processOutput}`,
  );
  const body = JSON.parse(responseText);
  assert.equal(typeof body.access_token, "string");
  return body.access_token;
}

before(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-learning-admin-auth-"));
  userDir = path.join(workDir, "userDir");
  const learningDir = path.join(workDir, "learning");
  fs.mkdirSync(userDir, { recursive: true });

  const candidate = buildLearningCandidates({
    prediction: { state: "on" },
    outcome: { state: "off" },
    runId: "run-real-admin-auth",
    skill: "e2e-auth",
  }).candidates[0];
  candidateId = candidate.id;
  const store = new LearningCandidateStore(learningDir);
  store.add(candidate);
  store.review(candidate.id, {
    decision: "approved",
    reviewer: "test-fixture-reviewer",
  });
  const pendingCandidate = buildLearningCandidates({
    prediction: { state: "closed" },
    outcome: { state: "open" },
    runId: "run-real-admin-review",
    skill: "e2e-auth",
  }).candidates[0];
  pendingCandidateId = pendingCandidate.id;
  store.add(pendingCandidate);

  const adminAuth = {
    type: "credentials",
    users: [
      {
        username: "redclaw-admin",
        password: bcrypt.hashSync(ADMIN_PASSWORD, 8),
        permissions: "*",
      },
      {
        username: "redclaw-reader",
        password: bcrypt.hashSync(READER_PASSWORD, 8),
        permissions: "redclaw.learning.read",
      },
      {
        username: "redclaw-reviewer",
        password: bcrypt.hashSync(REVIEWER_PASSWORD, 8),
        permissions: "redclaw.learning.review",
      },
    ],
  };
  const settings = {
    uiPort: PORT,
    flowFile: "flows.json",
    userDir: `${userDir}${path.sep}`,
    nodesDir: path.join(CORE_DIR, "nodes"),
    logging: { console: { level: "warn" } },
    adminAuth,
    editorTheme: { projects: { enabled: false } },
  };
  const flow = [
    { id: "learning-admin-tab", type: "tab", label: "learning-admin-auth-e2e" },
    {
      id: "learning-admin-reflect",
      type: "redclaw-reflect",
      z: "learning-admin-tab",
      name: "e2e authenticated learning store",
      skillName: "e2e-auth",
      useLlm: false,
      learningStoreDir: learningDir,
      wires: [[], []],
    },
  ];
  settingsPath = path.join(userDir, "settings.js");
  fs.writeFileSync(settingsPath, `module.exports = ${JSON.stringify(settings, null, 2)};\n`);
  fs.writeFileSync(path.join(userDir, "flows.json"), JSON.stringify(flow));

  await startNodeRed();
});

after(async () => {
  await stopNodeRed();
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

test("real Node-RED auth enforces dedicated learning permissions for admin routes", async () => {
  const readerToken = await accessToken("redclaw-reader", READER_PASSWORD);
  const reviewerToken = await accessToken("redclaw-reviewer", REVIEWER_PASSWORD);
  const adminToken = await accessToken("redclaw-admin", ADMIN_PASSWORD);

  const unauthenticatedResponse = await fetch(
    `${BASE_URL}/redclaw/learning-promotion-proposals`,
  );
  assert.equal(unauthenticatedResponse.status, 401);

  const readerListResponse = await fetch(
    `${BASE_URL}/redclaw/learning-promotion-proposals?n=20`,
    { headers: { Authorization: `Bearer ${readerToken}` } },
  );
  assert.equal(readerListResponse.status, 200);
  assert.deepEqual((await readerListResponse.json()).proposals, []);
  const readerFlowWriteResponse = await fetch(`${BASE_URL}/flows`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${readerToken}`,
      "Content-Type": "application/json",
      "Node-RED-Deployment-Type": "full",
    },
    body: "[]",
  });
  assert.equal(readerFlowWriteResponse.status, 401);

  const readerWriteResponse = await fetch(
    `${BASE_URL}/redclaw/learning-candidates/${candidateId}/promotion-proposal`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${readerToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  assert.equal(readerWriteResponse.status, 401);
  const readerReviewResponse = await fetch(
    `${BASE_URL}/redclaw/learning-candidates/${pendingCandidateId}/review`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${readerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ decision: "approved" }),
    },
  );
  assert.equal(readerReviewResponse.status, 401);

  const reviewerListResponse = await fetch(
    `${BASE_URL}/redclaw/learning-promotion-proposals`,
    { headers: { Authorization: `Bearer ${reviewerToken}` } },
  );
  assert.equal(reviewerListResponse.status, 401);
  const reviewerFlowReadResponse = await fetch(`${BASE_URL}/flows`, {
    headers: { Authorization: `Bearer ${reviewerToken}` },
  });
  assert.equal(reviewerFlowReadResponse.status, 401);

  const reviewerReviewResponse = await fetch(
    `${BASE_URL}/redclaw/learning-candidates/${pendingCandidateId}/review`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${reviewerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ decision: "approved", reviewer: "forged-reviewer" }),
    },
  );
  assert.equal(reviewerReviewResponse.status, 200);
  const reviewedCandidate = (await reviewerReviewResponse.json()).candidate;
  assert.equal(reviewedCandidate.review.reviewer, "redclaw-reviewer");
  assert.equal(reviewedCandidate.state, "approved");
  assert.equal(reviewedCandidate.active, false);

  const reviewerProposalResponse = await fetch(
    `${BASE_URL}/redclaw/learning-candidates/${candidateId}/promotion-proposal`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${reviewerToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  assert.equal(reviewerProposalResponse.status, 201);
  const { proposal } = await reviewerProposalResponse.json();
  assert.equal(proposal.createdBy, "redclaw-reviewer");
  assert.equal(proposal.approvedBy, "test-fixture-reviewer");
  assert.equal(Number.isNaN(Date.parse(proposal.approvedAt)), false);
  assert.equal(proposal.status, "prepared");
  assert.equal(proposal.active, false);

  const adminListResponse = await fetch(
    `${BASE_URL}/redclaw/learning-promotion-proposals?n=20`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );
  assert.equal(adminListResponse.status, 200);
  const listedProposals = (await adminListResponse.json()).proposals;
  assert.equal(listedProposals.length, 1);
  assert.equal(listedProposals[0].id, proposal.id);
  assert.equal(listedProposals[0].active, false);

  const adminReviewResponse = await fetch(
    `${BASE_URL}/redclaw/learning-candidates/${candidateId}/review`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ decision: "approved" }),
    },
  );
  assert.equal(adminReviewResponse.status, 409);

  await stopNodeRed();
  await startNodeRed();

  const restartedAdminToken = await accessToken("redclaw-admin", ADMIN_PASSWORD);
  const restartedListResponse = await fetch(
    `${BASE_URL}/redclaw/learning-promotion-proposals?n=20`,
    { headers: { Authorization: `Bearer ${restartedAdminToken}` } },
  );
  assert.equal(restartedListResponse.status, 200);
  const restartedProposals = (await restartedListResponse.json()).proposals;
  assert.equal(restartedProposals.length, 1);
  assert.deepEqual(restartedProposals[0], listedProposals[0]);

  const restartedCandidatesResponse = await fetch(
    `${BASE_URL}/redclaw/learning-candidates?n=20`,
    { headers: { Authorization: `Bearer ${restartedAdminToken}` } },
  );
  assert.equal(restartedCandidatesResponse.status, 200);
  const restartedCandidates = (await restartedCandidatesResponse.json()).candidates;
  assert.equal(
    restartedCandidates.find(item => item.id === candidateId).active,
    false,
  );
  assert.equal(
    restartedCandidates.find(item => item.id === pendingCandidateId).state,
    "approved",
  );
  assert.equal(
    restartedCandidates.find(item => item.id === pendingCandidateId).active,
    false,
  );
});
