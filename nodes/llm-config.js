/**
 * RedClaw - LLM Config Node
 * Config LLM partagée — supporte tous les backends (Ollama, OpenAI, Anthropic, REST).
 */
const LlmClient = require("../lib/llm-client");
const { timerDelayOrDefault } = require("../lib/numeric");
const { types } = require("node:util");
module.exports = function (RED) {
  function LlmConfigNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    let invalidConfigWarned = false;
    function readConfigValue(key) {
      if (!config || typeof config !== "object" || types.isProxy(config)) {
        if (!invalidConfigWarned) {
          node.warn("[LLM Config] Configuration must be a plain object; using defaults");
          invalidConfigWarned = true;
        }
        return { present: false, valid: false };
      }
      const descriptor = Object.getOwnPropertyDescriptor(config, key);
      if (!descriptor) return { present: false, valid: true };
      if (!Object.hasOwn(descriptor, "value")) {
        node.warn(`[LLM Config] Configuration "${key}" must be a data property; using its default`);
        return { present: true, valid: false };
      }
      return { present: true, valid: true, value: descriptor.value };
    }

    function configuredString(key, fallback, allowEmpty = false) {
      const configured = readConfigValue(key);
      if (!configured.valid || !configured.present || configured.value === undefined) {
        return fallback;
      }
      if (configured.value === null) {
        node.warn(`[LLM Config] Configuration "${key}" must be a string; using its default`);
        return fallback;
      }
      if (configured.value === "") return allowEmpty ? "" : fallback;
      if (typeof configured.value !== "string") {
        node.warn(`[LLM Config] Configuration "${key}" must be a string; using its default`);
        return fallback;
      }
      const value = configured.value.trim();
      return value || (allowEmpty ? "" : fallback);
    }

    node.llmType = configuredString("llmType", "ollama");
    node.baseUrl = configuredString("baseUrl", "http://localhost:11434");
    node.model = configuredString("model", "gemma3:4b");
    const configuredTimeout = readConfigValue("timeout");
    node.timeout = timerDelayOrDefault(
      configuredTimeout.valid ? configuredTimeout.value : undefined,
      60000,
    );
    if (configuredTimeout.valid && configuredTimeout.present &&
        configuredTimeout.value !== undefined &&
        timerDelayOrDefault(configuredTimeout.value, 0) === 0) {
      node.warn('[LLM Config] Configuration "timeout" must be a positive timer delay; using 60000');
    }
    node.apiKey         = (node.credentials && node.credentials.apiKey) || "";
    node.restPath = configuredString("restPath", "/chat");
    node.restBodyTpl = configuredString("restBodyTpl", "");
    node.restResultPath = configuredString("restResultPath", "response", true);
    node.client = new LlmClient({
      type: node.llmType, baseUrl: node.baseUrl, model: node.model,
      apiKey: node.apiKey, timeout: node.timeout,
      restPath: node.restPath, restBodyTpl: node.restBodyTpl, restResultPath: node.restResultPath,
    });
    node.label = () => node.llmType + " · " + node.model;
  }
  RED.nodes.registerType("llm-config", LlmConfigNode, { credentials: { apiKey: { type: "password" } } });
};
