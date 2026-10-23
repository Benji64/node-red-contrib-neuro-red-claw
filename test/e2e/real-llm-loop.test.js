/**
 * Test e2e le plus important resté manquant jusqu'ici : la vraie boucle
 * agentique (redclaw-orchestrator + llm-client.js) n'avait JAMAIS été
 * exercée dans toute la suite — tous les tests précédents (lib, nodes,
 * même le premier e2e) contournaient la décision LLM avec un nœud
 * `change` qui construit msg.redclaw directement.
 *
 * Pas de vrai modèle de langage disponible dans ce sandbox (pas de clé
 * API, pas d'accès réseau pour Ollama/HuggingFace) — mais on peut monter
 * un VRAI serveur HTTP qui répond dans le VRAI format OpenAI-compatible,
 * scripté en séquence comme le ferait un modèle réel sur 2 tours :
 *   1. décision "tool" (turn_on)
 *   2. décision "respond" (synthèse finale) — avec du texte parasite et
 *      des fences markdown autour du JSON, pour vérifier que _parse()
 *      gère vraiment ce cas réaliste, pas en théorie.
 *
 * Ça teste 100% du code d'intégration réel (protocole HTTP, format de
 * requête, extraction de la réponse, boucle tool-call → exécution →
 * synthèse) — tout sauf la qualité du raisonnement lui-même, qui n'est
 * de toute façon pas testable de façon déterministe.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path    = require("path");
const fs      = require("fs");
const os      = require("os");
const http    = require("http");
const { spawn } = require("child_process");

const CORE_DIR   = path.join(__dirname, "..", "..");
const RED_JS     = path.join(CORE_DIR, "node_modules", "node-red", "red.js");
const NR_PORT    = 19000 + Math.floor(Math.random() * 900);
const MOCK_PORT  = 20000 + Math.floor(Math.random() * 900);
const BASE_URL   = `http://127.0.0.1:${NR_PORT}`;

// ─── Serveur HTTP mock — répond au format OpenAI /v1/chat/completions ────────
// Scripté en séquence, comme le ferait un vrai modèle sur 2 tours de boucle.
let mockCallCount = 0;
const mockResponses = [
  // Tour 1 : décision d'appeler le tool turn_on — JSON propre
  JSON.stringify({ action: "tool", tool: "turn_on", params: { state: "ON" } }),
  // Tour 2 : synthèse finale — texte parasite + fences markdown volontaires,
  // pour vérifier que _parse() (agent-orchestrator.js) gère vraiment ce cas.
  "Voici ma décision :\n```json\n" +
    JSON.stringify({ action: "respond", message: "La lumière du salon est allumée." }) +
    "\n```\n",
];

let mockServer;

function startMockLlmServer() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const content = mockResponses[Math.min(mockCallCount, mockResponses.length - 1)];
        mockCallCount++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    mockServer.listen(MOCK_PORT, "127.0.0.1", resolve);
  });
}

const FLOW = [
  { id: "tab1", type: "tab", label: "e2e-llm" },

  { id: "llmcfg1", type: "llm-config", name: "mock",
    llmType: "openai", baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
    model: "test-model", timeout: 5000 },

  { id: "httpin1", type: "http in", z: "tab1", name: "trigger",
    url: "/ask", method: "post", upload: false, swaggerDoc: "",
    wires: [["prep1"]] },

  { id: "prep1", type: "change", z: "tab1", name: "prep",
    rules: [{ t: "set", p: "payload", pt: "msg", to: "allume le salon", tot: "str" }],
    wires: [["skill1"]] },

  { id: "skill1", type: "redclaw-skill", z: "tab1", name: "skill",
    skillName: "energie", context: "Contrôle les lumières.", tools: "turn_on",
    wires: [["orch1"]] },

  { id: "orch1", type: "redclaw-orchestrator", z: "tab1", name: "orch",
    llmMode: "internal", llmConfig: "llmcfg1", maxSteps: 5, maxHistory: 6,
    memoryEnabled: false, debugMode: false,
    wires: [["policy1"], ["httpresp1"], ["errresp1"]] },

  { id: "policy1", type: "redclaw-policy", z: "tab1", name: "policy",
    policies: "[]", logDecisions: false,
    wires: [["security1"], ["errresp1"], ["errresp1"]] },
  { id: "security1", type: "security-gate", z: "tab1", name: "security",
    rules: JSON.stringify([{ tool: "turn_on", action: "allow", riskCategories: ["technical"], impact: "low" }]),
    wires: [["router1"], ["errresp1"], ["errresp1"]] },

  { id: "router1", type: "mcp-router", z: "tab1", name: "router",
    tools: [{ name: "turn_on" }], timeout: 3000, debugMode: false,
    wires: [["adapter1"], ["orch1"]] },

  { id: "adapter1", type: "mcp-adapter", z: "tab1", name: "adapter",
    toolName: "turn_on", timeout: 2000,
    inputTransform: 'msg.payload = { dps: { "1": msg.payload.state === "ON" } }; return msg;',
    outputTransform: 'adaptateur.success = true; adaptateur.state = msg.payload.dps["1"] ? "ON" : "OFF";',
    wires: [["tuya1"], ["router1"]] },

  { id: "tuya1", type: "function", z: "tab1", name: "simule Tuya",
    func: "msg.payload = { dps: { '1': true } };\nreturn msg;", outputs: 1, timeout: 0,
    wires: [["adapter1"]] },

  { id: "httpresp1", type: "http response", z: "tab1", name: "réponse", statusCode: "", headers: {} },
  { id: "errresp1",  type: "http response", z: "tab1", name: "erreur",  statusCode: "500", headers: {} },
];

let proc, workDir;

before(async () => {
  await startMockLlmServer();

  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-e2e-llm-"));
  const userDir = path.join(workDir, "userDir");
  fs.mkdirSync(userDir, { recursive: true });

  fs.writeFileSync(path.join(userDir, "settings.js"), `
    module.exports = {
      uiPort: ${NR_PORT},
      flowFile: "flows.json",
      userDir: ${JSON.stringify(userDir + path.sep)},
      nodesDir: ${JSON.stringify(path.join(CORE_DIR, "nodes"))},
      logging: { console: { level: "warn" } },
      adminAuth: null,
      editorTheme: { projects: { enabled: false } },
      httpNodeRoot: "/api",
    };
  `);
  fs.writeFileSync(path.join(userDir, "flows.json"), JSON.stringify(FLOW));

  proc = spawn("node", [RED_JS, "--settings", path.join(userDir, "settings.js")], {
    cwd: userDir, stdio: "pipe",
  });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { if (await fetch(`${BASE_URL}/`)) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 300));
  }
  await new Promise(r => setTimeout(r, 800));
});

after(async () => {
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise(resolve => proc.once("exit", resolve));
    proc.kill();
    await exited;
  }
  if (mockServer) await new Promise(resolve => mockServer.close(resolve));
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

test("boucle agentique complète contre un vrai serveur HTTP OpenAI-compatible", async () => {
  const res  = await fetch(`${BASE_URL}/api/ask`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  const body = await res.text();

  assert.equal(res.status, 200, `attendu 200, reçu ${res.status} — body: ${body}`);
  assert.equal(body, "La lumière du salon est allumée.",
    "la synthèse finale doit être correctement extraite malgré le texte parasite et les fences markdown");
  assert.equal(mockCallCount, 2,
    "le mock LLM doit être appelé exactement 2 fois : décision tool, puis synthèse finale");
});
