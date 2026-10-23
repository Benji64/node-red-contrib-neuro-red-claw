"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const orchestrator = require("../../nodes/agent-orchestrator");

function instantiate(config) {
  let RegisteredNode;
  const errors = [];
  const warnings = [];
  const RED = {
    nodes: {
      createNode(node) {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        node.id = "orchestrator-config-test";
        node.status = () => {};
        node.error = error => errors.push(error);
        node.warn = warning => warnings.push(warning);
        node.log = () => {};
        node.send = () => {};
      },
      registerType(_type, constructor) {
        RegisteredNode = constructor;
      },
      getNode() {
        return null;
      },
      eachNode() {},
    },
    httpAdmin: {
      get() {},
    },
    auth: {
      needsPermission() {
        return () => {};
      },
    },
    settings: {
      userDir: process.env.TEMP,
    },
  };
  orchestrator(RED);
  const node = new RegisteredNode(config);
  return { node, errors, warnings };
}

test("refuses config accessors and Proxy objects without invoking them", () => {
  let getterInvoked = false;
  const config = {};
  Object.defineProperty(config, "treeSafetyEnabled", {
    enumerable: true,
    get() {
      getterInvoked = true;
      throw new Error("treeSafetyEnabled getter invoked");
    },
  });
  const accessorResult = instantiate(config);
  assert.equal(getterInvoked, false);
  assert.equal(accessorResult.errors.length, 1);
  assert.match(accessorResult.errors[0], /treeSafetyEnabled/);
  assert.equal(accessorResult.node.memory, undefined);

  let trapInvoked = false;
  const proxyConfig = new Proxy({}, {
    getOwnPropertyDescriptor() {
      trapInvoked = true;
      throw new Error("config Proxy trap invoked");
    },
  });
  const proxyResult = instantiate(proxyConfig);
  assert.equal(trapInvoked, false);
  assert.equal(proxyResult.errors.length, 1);
  assert.match(proxyResult.errors[0], /objet simple/);
  assert.equal(proxyResult.node.memory, undefined);
});

test("rejects malformed security booleans and references instead of disabling controls", () => {
  const safetyResult = instantiate({
    llmMode: "external",
    treeSafetyEnabled: "true",
  });
  assert.equal(safetyResult.errors.length, 1);
  assert.match(safetyResult.errors[0], /treeSafetyEnabled/);
  assert.equal(safetyResult.node.memory, undefined);

  const referenceResult = instantiate({
    llmMode: "external",
    evaluatorLlmConfig: { id: "attacker-controlled" },
  });
  assert.equal(referenceResult.errors.length, 1);
  assert.match(referenceResult.errors[0], /evaluatorLlmConfig/);
  assert.equal(referenceResult.node.memory, undefined);
});
