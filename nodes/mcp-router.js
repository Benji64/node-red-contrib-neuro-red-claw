/**
 * RedClaw — MCP Router (v3)
 *
 * Sorties :
 *   1..N  → une par tool (comme avant) + msg.routeur injecté
 *   N+1   → ⚡ Retour Orchestrateur
 *
 * msg.routeur sur chaque sortie tool :
 *   { tool, params, callId }
 *
 * Retour depuis un adapter :
 *   msg.adaptateur = résultat
 *   msg.redclaw_call_id = callId original
 */

module.exports = function (RED) {
  function McpRouterNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.tools   = (config.tools || []).filter(t => t.name);
    node.timeout   = parseInt(config.timeout, 10) || 15000;
    node.debugMode = config.debugMode === true;

    // Index nom → index de sortie
    node._idx   = {};
    node.tools.forEach((t, i) => { node._idx[t.name] = i; });

    // N tools + 1 retour orchestrateur
    node._total  = node.tools.length + 1;
    node._retour = node.tools.length;

    // Appels en attente : callId → { resolve, reject, timer }
    node._pending = new Map();

    node.status({
      fill:  "green",
      shape: "dot",
      text:  node.tools.map(t => t.name).join(", ") || "Aucun tool",
    });

    node.on("input", async function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      // ── CAS 1 : retour d'un adapter (msg.adaptateur présent) ─────────────
      if (msg.adaptateur !== undefined) {
        const callId = msg.redclaw_call_id;

        // Validation : le callId dans msg.adaptateur._callId doit correspondre
        if (msg.adaptateur._callId && msg.adaptateur._callId !== callId) {
          node.warn(`[MCP Router] callId invalide — attendu: ${callId}, reçu: ${msg.adaptateur._callId}`);
          done(); return;
        }

        const p = callId && node._pending.get(callId);

        if (p) {
          clearTimeout(p.timer);
          node._pending.delete(callId);
          // Nettoie _callId interne avant de transmettre le résultat
          const result = { ...msg.adaptateur };
          delete result._callId;
          p.resolve(result);
        } else {
          if (node.debugMode) node.warn(`[MCP Router] Résultat reçu mais callId inconnu ou expiré : ${callId}`);
        }
        done();
        return;
      }

      // ── CAS 2 : appel depuis l'orchestrateur (msg.redclaw.tool) ──────────
      const rc       = msg.redclaw;
      const toolName = rc?.tool;
      const callId   = msg.redclaw_call_id;

      if (!toolName || !callId) {
        if (node.debugMode) node.warn("[MCP Router] msg.redclaw.tool ou redclaw_call_id manquant");
        done(); return;
      }

      const toolIdx = node._idx[toolName];
      if (toolIdx === undefined) {
        if (node.debugMode) node.warn(`[MCP Router] Tool inconnu : "${toolName}". Configurés : ${node.tools.map(t=>t.name).join(", ")}`);
        const out = new Array(node._total).fill(null);
        out[node._retour] = { ...msg, payload: `Tool inconnu : "${toolName}"`, redclaw_error: `Tool inconnu : "${toolName}"` };
        send(out); done(); return;
      }

      node.status({ fill: "blue", shape: "dot", text: `→ ${toolName}` });
        if (node.debugMode) node.warn(`[MCP Router] → tool "${toolName}" callId:${callId} params:${JSON.stringify(rc.params||{})}`);

      try {
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            node._pending.delete(callId);
            reject(new Error(`Timeout "${toolName}" (${node.timeout}ms)`));
          }, node.timeout);

          node._pending.set(callId, { resolve, reject, timer });

          // Route vers la sortie du tool avec msg.routeur injecté
          const out = new Array(node._total).fill(null);
          out[toolIdx] = {
            ...msg,
            routeur: {
              tool:   toolName,
              params: rc.params || {},
              callId,
            },
          };
          send(out);
        });

        node.status({ fill: "green", shape: "dot", text: `✓ ${toolName}` });
        if (node.debugMode) node.warn(`[MCP Router] ✓ "${toolName}" résultat:${JSON.stringify(result)}`);

        // ⚡ Retour orchestrateur
        const out = new Array(node._total).fill(null);
        out[node._retour] = {
          ...msg,
          payload:         result,
          redclaw_call_id: callId,
        };
        send(out);

      } catch (e) {
        node.status({ fill: "red", shape: "ring", text: e.message.slice(0, 40) });
        node.error(`[MCP Router] ${e.message}`, msg);
        const out = new Array(node._total).fill(null);
        out[node._retour] = { ...msg, payload: e.message, redclaw_call_id: callId, redclaw_error: e.message };
        send(out);
      }

      done();
    });

    node.on("close", function () {
      for (const [, p] of node._pending) { clearTimeout(p.timer); p.reject(new Error("Nœud fermé")); }
      node._pending.clear();
      node.status({});
    });
  }

  RED.nodes.registerType("mcp-router", McpRouterNode);
};
