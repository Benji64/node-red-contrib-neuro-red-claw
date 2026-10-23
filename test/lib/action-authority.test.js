"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const authority = require("../../lib/action-authority");

test("permits are bound to tool, parameters, and session and can be consumed once", () => {
  const token = authority.issuePermit({
    tool: "write",
    params: { b: 2, a: 1 },
    sessionId: "session-1",
  });
  assert.equal(authority.inspectPermit(token, "write", { a: 1, b: 2 }, "session-1").allowed, true);
  assert.equal(authority.consumePermit(token, "write", { a: 2, b: 2 }, "session-1").allowed, false);
  assert.equal(authority.consumePermit(token, "write", { a: 1, b: 2 }, "session-1").allowed, false);

  const sessionBound = authority.issuePermit({
    tool: "write",
    params: { a: 1 },
    sessionId: "session-1",
  });
  assert.equal(authority.consumePermit(sessionBound, "write", { a: 1 }, "session-2").allowed, false);
});

test("revoked permits cannot be inspected or consumed", () => {
  const token = authority.issuePermit({
    tool: "write",
    params: { value: 1 },
    sessionId: "session-1",
    kind: "dispatch",
    correlationId: "call-1",
  });

  assert.equal(authority.revokePermit(token), true);
  assert.equal(authority.revokePermit(token), false);
  assert.equal(authority.inspectPermit(token, "write", { value: 1 }, "session-1", "dispatch").allowed, false);
  assert.equal(authority.consumePermit(token, "write", { value: 1 }, "session-1", "dispatch").allowed, false);
});

test("dispatch permits are bound to their correlation ID", () => {
  assert.throws(() => authority.issuePermit({
    tool: "write",
    params: { value: 1 },
    sessionId: "session-1",
    kind: "dispatch",
  }), /require a correlationId/);

  const token = authority.issuePermit({
    tool: "write",
    params: { value: 1 },
    sessionId: "session-1",
    kind: "dispatch",
    correlationId: "call-1",
  });

  assert.equal(authority.inspectPermit(
    token, "write", { value: 1 }, "session-1", "dispatch", "call-2",
  ).allowed, false);
  assert.equal(authority.inspectPermit(
    token, "write", { value: 1 }, "session-1", "dispatch", "call-1",
  ).allowed, true);
  assert.equal(authority.consumePermit(
    token, "write", { value: 1 }, "session-1", "dispatch", "call-1",
  ).allowed, true);
});

test("approval requests are one-use, bound to the original action, and run fresh authorization", () => {
  let reevaluations = 0;
  const id = authority.registerApprovalRequest({
    tool: "external_write",
    params: { value: "original" },
    sessionId: "s1",
    authorize() {
      reevaluations++;
      return authority.issuePermit({
        tool: "external_write",
        params: { value: "original" },
        sessionId: "s1",
      });
    },
  });
  assert.equal(authority.approveRequest(id, "external_write", { value: "changed" }, "s1").allowed, false);
  assert.equal(reevaluations, 0);
  assert.equal(authority.approveRequest(id, "external_write", { value: "original" }, "s1").allowed, false);

  const secondId = authority.registerApprovalRequest({
    tool: "external_write",
    params: { value: "original" },
    sessionId: "s1",
    authorize() {
      reevaluations++;
      return authority.issuePermit({
        tool: "external_write",
        params: { value: "original" },
        sessionId: "s1",
      });
    },
  });
  const approved = authority.approveRequest(secondId, "external_write", { value: "original" }, "s1");
  assert.equal(approved.allowed, true);
  assert.equal(reevaluations, 1);
});

test("rejects invalid authorization data and policy failures fail closed", () => {
  assert.throws(() => authority.issuePermit({ tool: "x", params: undefined, sessionId: "s" }), /acyclic JSON/);
  assert.throws(() => authority.issuePermit({ tool: "x", params: {}, sessionId: "s", ttlMs: 300001 }), /ttlMs/);
  const id = authority.registerApprovalRequest({
    tool: "x",
    params: {},
    sessionId: "s",
    authorize() { throw new Error("policy unavailable"); },
  });
  assert.deepEqual(authority.approveRequest(id, "x", {}, "s"), {
    allowed: false,
    reason: "Safety re-evaluation failed: policy unavailable",
  });
});

test("rejects Proxy params without invoking their traps", () => {
  let trapInvoked = false;
  const params = new Proxy({}, {
    getPrototypeOf() {
      trapInvoked = true;
      throw new Error("getPrototypeOf trap invoked");
    },
    ownKeys() {
      trapInvoked = true;
      throw new Error("ownKeys trap invoked");
    },
  });

  assert.throws(() => authority.issuePermit({
    tool: "write",
    params,
    sessionId: "session-1",
  }), /must not contain Proxy objects/);
  assert.equal(trapInvoked, false);
});
