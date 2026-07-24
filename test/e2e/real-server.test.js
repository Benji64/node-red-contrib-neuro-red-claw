/**
 * Test end-to-end contre un VRAI serveur Node-RED démarré à froid —
 * pas le harness simulé de node-red-node-test-helper. Déploie un vrai
 * flows.json tel qu'il serait stocké sur disque, pilote via une vraie
 * requête HTTP cliente, observe la vraie réponse.
 *
 * Ce niveau de test existe pour une raison précise : le fix historique
 * des sorties dynamiques de mcp-router (outputs dans defaults + input
 * hidden pour que Node-RED les persiste et les recrée au redéploiement)
 * avait été découvert et corrigé À LA MAIN, jamais vérifié
 * automatiquement. Ce test reproduit exactement ce scénario : déployer,
 * requêter, redéployer le MÊME flow via l'Admin API réelle (simulateur
 * d'un clic Deploy), requêter à nouveau, comparer.
 *
 * Plus lent que le reste de la suite (~5-8s, vrai boot serveur) —
 * volontairement isolé dans test/e2e/ plutôt que test/nodes/.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path   = require("path");
const fs     = require("fs");
const os     = require("os");
const { spawn } = require("child_process");

const CORE_DIR   = path.join(__dirname, "..", "..");
const RED_JS     = path.join(CORE_DIR, "node_modules", "node-red", "red.js");
const PORT       = 18000 + Math.floor(Math.random() * 900); // évite les collisions entre runs parallèles
const BASE_URL   = `http://127.0.0.1:${PORT}`;

const FLOW = [
  { id: "tab1", type: "tab", label: "e2e" },
  { id: "httpin1", type: "http in", z: "tab1", name: "trigger",
    url: "/turn-on", method: "post", upload: false, swaggerDoc: "",
    wires: [["prep1"]] },
  { id: "prep1", type: "change", z: "tab1", name: "prep",
    rules: [
      { t: "set", p: "redclaw", pt: "msg",
        to: JSON.stringify({ tool: "turn_on", params: { state: "ON" } }), tot: "json" },
      { t: "set", p: "redclaw_call_id", pt: "msg", to: "e2e-call-1", tot: "str" },
      { t: "set", p: "sessionId", pt: "msg", to: "energie", tot: "str" },
    ],
    wires: [["policy1"]] },
  { id: "policy1", type: "redclaw-policy", z: "tab1", name: "policy",
    agentRole: "default", policies: "[]", logDecisions: false,
    wires: [["router1"], ["blocked"], ["blocked"]] },
  { id: "blocked", type: "http response", z: "tab1", statusCode: "500", headers: {} },
  { id: "router1", type: "mcp-router", z: "tab1", name: "router",
    tools: [{ name: "turn_on" }], timeout: 3000, debugMode: false,
    wires: [["adapter1"], ["finalize1"]] },
  { id: "adapter1", type: "mcp-adapter", z: "tab1", name: "adapter",
    toolName: "turn_on", timeout: 2000,
    inputTransform: 'msg.payload = { dps: { "1": msg.payload.state === "ON" } }; return msg;',
    outputTransform: 'adaptateur.success = true; adaptateur.state = msg.payload.dps["1"] ? "ON" : "OFF";',
    wires: [["tuya1"], ["router1"]] },
  { id: "tuya1", type: "function", z: "tab1", name: "simule Tuya",
    func: "msg.payload = { dps: { '1': true } };\nreturn msg;", outputs: 1, timeout: 0,
    wires: [["adapter1"]] },
  { id: "finalize1", type: "change", z: "tab1", name: "vers réponse",
    rules: [{ t: "set", p: "payload", pt: "msg", to: "payload", tot: "msg" }],
    wires: [["httpresp1"]] },
  { id: "httpresp1", type: "http response", z: "tab1", name: "réponse",
    statusCode: "", headers: {} },
];

let proc, workDir;

before(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-e2e-"));
  const userDir = path.join(workDir, "userDir");
  fs.mkdirSync(userDir, { recursive: true });

  fs.writeFileSync(path.join(userDir, "settings.js"), `
    module.exports = {
      uiPort: ${PORT},
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

  // Attend que le serveur réponde
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/`);
      if (res) break;
    } catch (_) { /* pas encore up */ }
    await new Promise(r => setTimeout(r, 300));
  }
  await new Promise(r => setTimeout(r, 800)); // marge pour que le flow soit pleinement actif
});

after(() => {
  if (proc) proc.kill();
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

test("vrai serveur, vrai flow, vraie requête HTTP → réponse correcte", async () => {
  const res  = await fetch(`${BASE_URL}/api/turn-on`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.state, "ON");
  assert.equal(body.callId, undefined, "le callId interne ne doit jamais fuiter dans la réponse HTTP");
});

test("redéploiement du MÊME flow via l'Admin API réel : le wiring dynamique de mcp-router survit", async () => {
  const before = await (await fetch(`${BASE_URL}/api/turn-on`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  })).json();

  const deployRes = await fetch(`${BASE_URL}/flows`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Node-RED-Deployment-Type": "full" },
    body: JSON.stringify(FLOW),
  });
  assert.equal(deployRes.status, 204, "le redéploiement admin doit réussir");

  await new Promise(r => setTimeout(r, 800));

  const after = await (await fetch(`${BASE_URL}/api/turn-on`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  })).json();
  assert.deepEqual(after, before, "comportement identique avant/après redéploiement");

  const flowsAfter = await (await fetch(`${BASE_URL}/flows`)).json();
  const router = flowsAfter.find(n => n.id === "router1");
  assert.equal(router.wires.length, 2, "les 2 sorties dynamiques de mcp-router doivent être recréées après redeploy");
});
