/**
 * RedClaw - Security Gate
 *
 * Valide chaque tool call avant exécution.
 * Se place entre l'Orchestrateur (Output 1) et le MCP Router.
 *
 * Sorties :
 *   Output 1 : ✅ Autorisé   → MCP Router
 *   Output 2 : ⏳ Confirmation requise → UI humaine
 *   Output 3 : 🚫 Bloqué    → log / alerte
 */

const SecurityPolicy = require("../lib/security-policy");
const { randomUUID } = require("crypto");

module.exports = function (RED) {
  function SecurityGateNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.defaultAction  = config.defaultAction  || "allow";
    node.logBlocked     = config.logBlocked     !== false;
    node.confirmTimeout = parseInt(config.confirmTimeout, 10) || 60000;

    let rules = [];
    try { if (config.rules?.trim()) rules = JSON.parse(config.rules); } catch (_) {}

    let globalRateLimit = null;
    try { if (config.globalRateLimit?.trim()) globalRateLimit = JSON.parse(config.globalRateLimit); } catch (_) {}

    node.policy  = new SecurityPolicy({ rules, defaultAction: node.defaultAction, globalRateLimit });
    node._pending = new Map(); // callId → { msg, send, timer, toolName }

    node.status({ fill:"green", shape:"dot", text:`${rules.length} règle(s) · défaut: ${node.defaultAction}` });

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      // ── Réponse de confirmation humaine ───────────────────────────────────
      if (msg.redclaw_confirm) {
        const { callId, approved } = msg.redclaw_confirm;
        const p = node._pending.get(callId);
        if (!p) { done(); return; }
        clearTimeout(p.timer);
        node._pending.delete(callId);
        if (approved) {
          node.status({ fill:"green", shape:"dot", text:`✓ Confirmé: ${p.toolName}` });
          p.send([{ ...p.msg }, null, null]);
        } else {
          node.status({ fill:"yellow", shape:"ring", text:`✗ Refusé: ${p.toolName}` });
          p.send([null, null, { ...p.msg, payload:`Refusé: ${p.toolName}`, redclaw_security:{ blocked:true, reason:"Refus manuel" }}]);
        }
        done(); return;
      }

      // ── Évaluation d'un tool call ─────────────────────────────────────────
      const toolName  = msg.redclaw?.tool || "";
      const params    = msg.redclaw?.params || msg.payload || {};
      const sessionId = msg.sessionId || "default";

      // Pas un tool call → laisse passer
      if (!toolName) { send([msg, null, null]); done(); return; }

      const ev = node.policy.evaluate(toolName, params, sessionId);

      if (!ev.allowed) {
        node.status({ fill:"red", shape:"ring", text:`🚫 ${toolName}` });
        if (node.logBlocked) node.warn(`[Security Gate] BLOQUÉ "${toolName}" — ${ev.reason}`);
        send([null, null, { ...msg, payload: ev.reason, redclaw_security:{ blocked:true, tool:toolName, reason:ev.reason }}]);
        done(); return;
      }

      if (ev.requireConfirm) {
        const callId = randomUUID();
        node.status({ fill:"yellow", shape:"ring", text:`⏳ ${toolName}` });
        const timer = setTimeout(() => {
          node._pending.delete(callId);
          send([null, null, { ...msg, payload:`Timeout confirmation "${toolName}"`, redclaw_security:{ blocked:true, tool:toolName, reason:"Timeout" }}]);
        }, node.confirmTimeout);
        node._pending.set(callId, { msg, send, timer, toolName });
        send([null, { ...msg, payload:{ message:ev.reason, callId, tool:toolName, params }, redclaw_confirm_request:{ callId, tool:toolName, reason:ev.reason }}, null]);
        done(); return;
      }

      // Autorisé
      node.status({ fill:"green", shape:"dot", text:`✓ ${toolName}` });
      send([{ ...msg, redclaw_security:{ allowed:true, tool:toolName }}, null, null]);
      done();
    });

    node.on("close", function () {
      node.policy.destroy();
      for (const [,p] of node._pending) clearTimeout(p.timer);
      node._pending.clear();
      node.status({});
    });
  }

  RED.nodes.registerType("security-gate", SecurityGateNode);
};
