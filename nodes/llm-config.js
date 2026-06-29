/**
 * RedClaw - LLM Config Node
 * Config LLM partagée — supporte tous les backends (Ollama, OpenAI, Anthropic, REST).
 */
const LlmClient = require("../lib/llm-client");
module.exports = function (RED) {
  function LlmConfigNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.llmType        = config.llmType    || "ollama";
    node.baseUrl        = config.baseUrl    || "http://localhost:11434";
    node.model          = config.model      || "gemma3:4b";
    node.timeout        = parseInt(config.timeout, 10) || 60000;
    node.apiKey         = (node.credentials && node.credentials.apiKey) || "";
    node.restPath       = config.restPath       || "/chat";
    node.restBodyTpl    = config.restBodyTpl    || "";
    node.restResultPath = config.restResultPath || "response";
    node.client = new LlmClient({
      type: node.llmType, baseUrl: node.baseUrl, model: node.model,
      apiKey: node.apiKey, timeout: node.timeout,
      restPath: node.restPath, restBodyTpl: node.restBodyTpl, restResultPath: node.restResultPath,
    });
    node.label = () => node.llmType + " · " + node.model;
  }
  RED.nodes.registerType("llm-config", LlmConfigNode, { credentials: { apiKey: { type: "password" } } });
};
