/**
 * RedClaw v1.7 — Hub
 *
 * Routeur cognitif entre agents. Même pattern que MCP Router mais pour les skills.
 * Chaque sortie est câblée vers un skill. Le résultat revient sur l'entrée du hub.
 *
 * ─── Sorties ─────────────────────────────────────────────────────────────────
 *  1..N  → une par skill configuré → câbler vers l'entrée du skill cible
 *  N+1   → ⚡ Résultat → vers l'orchestrateur appelant
 *
 * ─── Entrée ──────────────────────────────────────────────────────────────────
 *  msg.redclaw_hub.action = "delegate" + .target + .question → délégation
 *  msg.redclaw_hub.action = "context"                        → snapshot
 *  msg.redclaw_hub_return (retour d'un orchestrateur enfant) → résout la Promise
 *
 * ─── Câblage ─────────────────────────────────────────────────────────────────
 *  [Orchestrateur CEO] Output1 ──► [Hub]
 *    ├─ 1 ──► [skill: energie] → [Orch Energie] Output2 ──► [Hub] entrée
 *    ├─ 2 ──► [skill: confort] → [Orch Confort] Output2 ──► [Hub] entrée
 *    └─ ⚡ ──► [Orchestrateur CEO] entrée
 */

const { randomUUID }  = require("crypto");
const skillRegistry   = require("../lib/skill-registry");
const goalStore       = require("../lib/goal-store");
const ticketStore     = require("../lib/ticket-store");
const ConversationMemory = require("../lib/conversation-memory");
const path = require("path");
const os   = require("os");

module.exports = function (RED) {
  function RedclawHubNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.skills    = (config.skills || []).filter(s => s.name);
    node.timeout   = parseInt(config.timeout, 10) || 30000;
    node.debugMode = config.debugMode === true;

    // Index nom → index de sortie (comme mcp-router)
    node._idx    = {};
    node.skills.forEach((s, i) => { node._idx[s.name] = i; });
    node._total  = node.skills.length + 1;
    node._retour = node.skills.length;

    // Délégations en attente
    node._pending = new Map();

    const memDir = config.memoryDir?.trim()
      || path.join(RED.settings.userDir || os.homedir() + "/.node-red", "redclaw-memory");
    node.memory = new ConversationMemory(memDir, { maxMessages: 20 });

    node._statusTimer = setInterval(() => {
      const n = skillRegistry.all().filter(s => s.status !== "offline").length;
      node.status({ fill: n ? "green" : "yellow", shape: "dot",
        text: `${n} skill(s) · ${node.skills.length} câblé(s)` });
    }, 10000);

    node.status({ fill: "green", shape: "dot",
      text: `Hub · ${node.skills.map(s => s.name).join(", ") || "aucun skill câblé"}` });

    node.on("input", async function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      // ── Retour d'un orchestrateur enfant ──────────────────────────────
      if (msg.redclaw_hub_return) {
        const { callId, result } = msg.redclaw_hub_return;
        const p = callId && node._pending.get(callId);
        if (p) { clearTimeout(p.timer); node._pending.delete(callId); p.resolve(result || msg.payload); }
        done(); return;
      }

      const action = msg.redclaw_hub?.action || "context";

      // ── Snapshot cross-skills ─────────────────────────────────────────
      if (action === "context") {
        const snapshot = _buildSnapshot();
        if (node.debugMode) node.warn(`[Hub] Snapshot : ${snapshot.skillCount} skills`);
        const out = new Array(node._total).fill(null);
        out[node._retour] = { ...msg, payload: snapshot, redclaw_hub_context: snapshot };
        send(out);
        done(); return;
      }

      // ── Délégation vers un skill câblé ───────────────────────────────
      if (action === "delegate") {
        const target   = msg.redclaw_hub.target;
        const question = msg.redclaw_hub.question || msg.payload;

        if (!target) { node.error("[Hub] msg.redclaw_hub.target manquant", msg); done(); return; }

        const idx = node._idx[target];
        if (idx === undefined) {
          const avail = node.skills.map(s => s.name).join(", ") || "aucun";
          node.warn(`[Hub] Skill "${target}" non câblé. Câblés : ${avail}`);
          const out = new Array(node._total).fill(null);
          out[node._retour] = { ...msg, payload: `Skill "${target}" non câblé`, redclaw_hub_error: true };
          send(out); done(); return;
        }

        if (node.debugMode) node.warn(`[Hub] → ${target} : "${String(question).slice(0,60)}"`);
        node.status({ fill: "blue", shape: "dot", text: `→ ${target}` });

        try {
          const callId = randomUUID().slice(0, 8);
          const result = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              node._pending.delete(callId);
              reject(new Error(`Timeout délégation "${target}" (${node.timeout}ms)`));
            }, node.timeout);
            node._pending.set(callId, { resolve, reject, timer });

            // Route vers la sortie du skill cible
            const out = new Array(node._total).fill(null);
            out[idx] = {
              payload:           question,
              sessionId:         target,
              redclaw_hub_call:  { callId, source: msg.sessionId || "hub", target },
            };
            send(out);
          });

          node.status({ fill: "green", shape: "dot", text: `✓ ${target}` });
          const out = new Array(node._total).fill(null);
          out[node._retour] = { ...msg, payload: result, redclaw_hub_result: { target, result } };
          send(out);

        } catch (e) {
          node.status({ fill: "red", shape: "ring", text: e.message.slice(0, 40) });
          node.error(`[Hub] ${e.message}`, msg);
          const out = new Array(node._total).fill(null);
          out[node._retour] = { ...msg, payload: e.message, redclaw_hub_error: true };
          send(out);
        }
        done(); return;
      }

      node.warn(`[Hub] Action inconnue : "${action}"`); done();
    });

    function _buildSnapshot() {
      const skills   = skillRegistry.snapshot(node.memory, ticketStore);
      const goals    = goalStore.active();
      return {
        generatedAt:       new Date().toISOString(),
        skillCount:        skills.filter(s => s.status !== "offline").length,
        skills, goals,
        goalContext:       goalStore.buildGoalContext(),
        capabilitiesIndex: skillRegistry.buildCapabilitiesIndex(),
        criticalGoals:     goalStore.critical().map(g => g.name),
      };
    }

    node.on("close", function () {
      clearInterval(node._statusTimer);
      for (const [, p] of node._pending) { clearTimeout(p.timer); p.reject(new Error("Hub fermé")); }
      node._pending.clear();
      if (node.memory?.destroy) node.memory.destroy();
      node.status({});
    });
  }

  RED.httpAdmin.get("/redclaw/hub", RED.auth.needsPermission("flows.read"),
    (req, res) => res.json({ skills: skillRegistry.all(), index: skillRegistry.buildCapabilitiesIndex() }));
  RED.httpAdmin.get("/redclaw/hub/goals", RED.auth.needsPermission("flows.read"),
    (req, res) => res.json({ goals: goalStore.all(), goalContext: goalStore.buildGoalContext() }));
  RED.httpAdmin.get("/redclaw/hub/snapshot", RED.auth.needsPermission("flows.read"),
    (req, res) => {
      const mem = new ConversationMemory(
        path.join(RED.settings.userDir || os.homedir()+"/.node-red","redclaw-memory"),
        { maxMessages: 20 });
      res.json(skillRegistry.snapshot(mem, ticketStore));
    });

  RED.nodes.registerType("redclaw-hub", RedclawHubNode);
};
