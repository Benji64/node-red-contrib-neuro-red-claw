/**
 * neuro-red-claw — Chat UI
 *
 * Interface conversationnelle pour les échanges avec les LLM.
 * Compatible Dashboard 2.0 via les sorties structurées.
 *
 * ─── Entrées ──────────────────────────────────────────────────────────────────
 *  Depuis redclaw-skill (demande) :
 *    msg.payload         = question utilisateur
 *    msg.redclaw.skill   = contexte du skill
 *    msg.sessionId       = session
 *
 *  Depuis redclaw-orchestrator Output 2 (réponse) :
 *    msg.payload         = réponse du LLM
 *    msg.redclaw.success = true/false
 *
 *  Depuis Dashboard 2.0 (ui-text-input) :
 *    msg.payload         = nouvelle demande de l'utilisateur
 *    msg.topic = "user_input"
 *
 * ─── Sorties ──────────────────────────────────────────────────────────────────
 *  Output 1 → message formaté → ui-template / ui-text (Dashboard 2.0)
 *  Output 2 → demande vers le skill → redclaw-skill
 *  Output 3 → historique complet → ui-template (tableau)
 */

module.exports = function (RED) {
  function NeuroChatNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.skillTarget = (config.skillTarget || "").trim();
    node.maxHistory  = parseInt(config.maxHistory, 10) || 50;
    node.uiTitle     = config.uiTitle || "neuro-red-claw Chat";

    // Historique des conversations en mémoire
    node._conversations = []; // [{ role, content, ts, skill, success }]
    node._pending       = false;

    _updateStatus();

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      // ── Réponse du LLM (depuis orchestrateur Output 2) ───────────────
      if (msg.redclaw?.finalResponse || (msg.redclaw?.success !== undefined)) {
        const content = msg.payload;
        const success = msg.redclaw?.success !== false;

        node._conversations.push({
          role:      "assistant",
          content:   String(content),
          ts:        new Date().toISOString(),
          skill:     msg.redclaw?.skill?.name || "",
          success,
          request_id: msg.redclaw_request_id || "",
        });
        _trim();
        node._pending = false;
        _updateStatus();

        // Output 1 → Dashboard 2.0
        send([_formatForDashboard(msg), null, _historyMsg(msg)]);
        done(); return;
      }

      // ── Demande utilisateur depuis Dashboard (ui-text-input) ─────────
      if (msg.topic === "user_input" || (msg.payload && !msg.redclaw)) {
        const content = String(msg.payload).trim();
        if (!content) { done(); return; }

        node._conversations.push({
          role:    "user",
          content,
          ts:      new Date().toISOString(),
          skill:   node.skillTarget,
        });
        _trim();
        node._pending = true;
        _updateStatus();

        // Output 1 → Dashboard (affiche message utilisateur immédiatement)
        // Output 2 → vers le skill cible
        send([
          _formatForDashboard(msg),
          {
            payload:   content,
            sessionId: `chat_${node.id.slice(0,6)}`,
            topic:     node.skillTarget || undefined,
          },
          null,
        ]);
        done(); return;
      }

      done();
    });

    // ── Helpers ──────────────────────────────────────────────────────────
    function _formatForDashboard(msg) {
      const last = node._conversations.slice(-1)[0] || {};
      return {
        ...msg,
        payload: {
          // Format compatible ui-template Dashboard 2.0
          type:         "chat_update",
          title:        node.uiTitle,
          last_message: last,
          conversations: node._conversations.slice(-20),
          pending:       node._pending,
          stats: {
            total:     node._conversations.length,
            user:      node._conversations.filter(c => c.role==="user").length,
            assistant: node._conversations.filter(c => c.role==="assistant").length,
          },
        },
        // Champs directs pour ui-text simple
        ui_payload:    last.content || "",
        ui_role:       last.role || "",
        ui_ts:         last.ts || "",
      };
    }

    function _historyMsg(msg) {
      return {
        ...msg,
        payload: node._conversations.map((c, i) => ({
          "#":     i + 1,
          Rôle:    c.role === "user" ? "👤 Vous" : "🤖 Agent",
          Message: c.content.slice(0, 100) + (c.content.length > 100 ? "…" : ""),
          Skill:   c.skill || "-",
          Heure:   new Date(c.ts).toLocaleTimeString(),
          Status:  c.success === false ? "❌" : "✅",
        })),
      };
    }

    function _trim() {
      if (node._conversations.length > node.maxHistory) {
        node._conversations = node._conversations.slice(-node.maxHistory);
      }
    }

    function _updateStatus() {
      const n = node._conversations.length;
      node.status({
        fill:  node._pending ? "blue" : "green",
        shape: node._pending ? "ring" : "dot",
        text:  `${n} msg${node._pending ? " · En attente…" : ""}`,
      });
    }

    node.on("close", () => node.status({}));
  }

  RED.nodes.registerType("neuro-chat", NeuroChatNode);
};
