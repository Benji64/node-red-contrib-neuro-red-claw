"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const llmConfig = require("../../nodes/llm-config");

function createRuntime(config) {
  const warnings = [];
  let RegisteredNode;
  const RED = {
    nodes: {
      createNode(node) {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        node.id = "llm-config-test";
        node.credentials = {};
        node.warn = warning => warnings.push(warning);
      },
      registerType(type, constructor) {
        assert.equal(type, "llm-config");
        RegisteredNode = constructor;
      },
    },
  };
  llmConfig(RED);
  const node = new RegisteredNode(config);
  return { node, warnings };
}

test("reads LLM config without invoking accessors", () => {
  let getterInvoked = false;
  const config = {};
  for (const key of ["llmType", "baseUrl", "model", "timeout", "restPath",
    "restBodyTpl", "restResultPath"]) {
    Object.defineProperty(config, key, {
      enumerable: true,
      get() {
        getterInvoked = true;
        throw new Error(`${key} getter invoked`);
      },
    });
  }

  const { node, warnings } = createRuntime(config);

  assert.equal(getterInvoked, false);
  assert.equal(node.llmType, "ollama");
  assert.equal(node.baseUrl, "http://localhost:11434");
  assert.equal(node.model, "gemma3:4b");
  assert.equal(node.timeout, 60000);
  assert.equal(node.restPath, "/chat");
  assert.equal(node.restBodyTpl, "");
  assert.equal(node.restResultPath, "response");
  assert.equal(warnings.length, 7);
});

test("uses defaults for config Proxy without invoking traps", () => {
  let trapInvoked = false;
  const config = new Proxy({}, {
    getOwnPropertyDescriptor() {
      trapInvoked = true;
      throw new Error("config Proxy trap invoked");
    },
  });

  const { node, warnings } = createRuntime(config);

  assert.equal(trapInvoked, false);
  assert.equal(node.llmType, "ollama");
  assert.equal(node.timeout, 60000);
  assert.equal(warnings.length, 1);
});

test("validates string fields and timeout while preserving valid configuration", () => {
  const invalid = createRuntime({
    llmType: 4,
    baseUrl: { toString: () => "https://unexpected.example" },
    model: "   ",
    timeout: "10seconds",
    restPath: 7,
    restBodyTpl: null,
    restResultPath: false,
  });
  assert.equal(invalid.node.llmType, "ollama");
  assert.equal(invalid.node.baseUrl, "http://localhost:11434");
  assert.equal(invalid.node.model, "gemma3:4b");
  assert.equal(invalid.node.timeout, 60000);
  assert.equal(invalid.node.restPath, "/chat");
  assert.equal(invalid.node.restBodyTpl, "");
  assert.equal(invalid.node.restResultPath, "response");
  assert.equal(invalid.warnings.length, 6);

  const valid = createRuntime({
    llmType: " rest ",
    baseUrl: " https://api.example.test/ ",
    model: " local-model ",
    timeout: "45000",
    restPath: " /v1/chat ",
    restBodyTpl: '{"prompt":"{{user}}"}',
    restResultPath: "result.text",
  });
  assert.equal(valid.node.llmType, "rest");
  assert.equal(valid.node.baseUrl, "https://api.example.test/");
  assert.equal(valid.node.model, "local-model");
  assert.equal(valid.node.timeout, 45000);
  assert.equal(valid.node.restPath, "/v1/chat");
  assert.equal(valid.node.restBodyTpl, '{"prompt":"{{user}}"}');
  assert.equal(valid.node.restResultPath, "result.text");
  assert.deepEqual(valid.warnings, []);

  const rootResult = createRuntime({
    llmType: "rest",
    restResultPath: "",
  });
  assert.equal(rootResult.node.restResultPath, "");
  assert.deepEqual(rootResult.warnings, []);
});
