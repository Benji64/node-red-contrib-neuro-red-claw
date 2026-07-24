/**
 * neuro-red-claw — Chat UI
 *
 * v2.13 — Deux flux strictement séparés, jamais mélangés :
 *   1. CHAT     : question utilisateur → réponse LLM (réactif, Q&A classique)
 *   2. ASSISTANCE : messages poussés automatiquement, sans question préalable
 *      (objectif atteint, insight de réflexion, observation notable, alerte hub…)
 *
 * Compatible Dashboard 2.0 via les sorties structurées.
 *
 * ─── Entrées ──────────────────────────────────────────────────────────────────
 *
 *  CHAT — depuis Dashboard 2.0 (ui-text-input) :
 *    msg.payload = nouvelle demande de l'utilisateur
 *    msg.topic   = "user_input"
 *
 *  CHAT — depuis redclaw-orchestrator Output 2 (réponse à CETTE demande) :
 *    msg.payload         = réponse du LLM
 *    msg.redclaw.success = true/false
 *    (reconnu automatiquement — c'est la réponse réactive normale)
 *
 *  ASSISTANCE — n'importe quelle source poussée sans question préalable :
 *    msg.chat_kind = "proactive"           (marqueur explicite, prioritaire)
 *    msg.chat_source   = "goal" | "reflect" | "observe" | "hub" | "..."  (optionnel)
 *    msg.chat_category = "info" | "success" | "warning" | "alert"       (optionnel, défaut "info")
 *    msg.payload = contenu du message
 *
 *    Auto-détection (si chat_kind absent) : reconnaît nativement les
 *    sorties de redclaw-goal (achieved), redclaw-reflect, redclaw-observe,
 *    redclaw-hub — pas de nœud change nécessaire pour ces sources cœur.
 *
 * ─── Sorties ──────────────────────────────────────────────────────────────────
 *  Output 1 → CHAT     — mise à jour → ui-template / ui-text (Dashboard 2.0)
 *  Output 2 → demande vers le skill → redclaw-skill
 *  Output 3 → CHAT     — historique complet → ui-template (tableau)
 *  Output 4 → ASSISTANCE — mise à jour → ui-template / ui-list (Dashboard 2.0)
 */

module.exports = function (RED) {
  function NeuroChatNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.skillTarget = (config.skillTarget || "").trim();
    node.maxHistory  = parseInt(config.maxHistory, 10) || 50;
    node.uiTitle     = config.uiTitle     || "neuro-red-claw Chat";
    node.assistTitle = config.assistTitle || "Assistance";

    // Deux historiques strictement indépendants
    node._conversations = []; // [{ role, content, ts, skill, success }] — Q&A uniquement
    node._assistance    = []; // [{ content, ts, source, category }]    — poussé automatique uniquement
    node._pending       = false;

    _updateStatus();

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      // ── CHAT — réponse réactive du LLM (depuis orchestrateur Output 2) ──
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
        _trimChat();
        node._pending = false;
        _updateStatus();

        send([_formatChat(msg), null, _historyMsg(msg), null]);
        done(); return;
      }

      // ── CHAT — demande utilisateur depuis Dashboard (ui-text-input) ─────
      if (msg.topic === "user_input" || (msg.payload && !msg.redclaw && !_isProactive(msg))) {
        const content = String(msg.payload).trim();
        if (!content) { done(); return; }

        node._conversations.push({
          role:    "user",
          content,
          ts:      new Date().toISOString(),
          skill:   node.skillTarget,
        });
        _trimChat();
        node._pending = true;
        _updateStatus();

        send([
          _formatChat(msg),
          {
            payload:   content,
            sessionId: `chat_${node.id.slice(0,6)}`,
            topic:     node.skillTarget || undefined,
          },
          null,
          null,
        ]);
        done(); return;
      }

      // ── ASSISTANCE — message poussé automatiquement, sans question ──────
      if (_isProactive(msg)) {
        const entry = {
          content:  String(msg.payload ?? ""),
          ts:       new Date().toISOString(),
          source:   msg.chat_source   || _autoSource(msg) || "system",
          category: msg.chat_category || "info",
        };
        node._assistance.push(entry);
        _trimAssistance();
        _updateStatus();

        send([null, null, null, _formatAssistance(msg)]);
        done(); return;
      }

      done();
    });

    // ── Détection ────────────────────────────────────────────────────────────

    // Reconnaît un message proactif : marqueur explicite, ou sortie
    // reconnaissable d'un nœud cœur qui pousse sans question préalable.
    function _isProactive(msg) {
      if (msg.chat_kind === "proactive") return true;
      if (msg.redclaw_goal_achieved)     return true; // redclaw-goal Output 2
      if (msg.redclaw_reflect)           return true; // redclaw-reflect Output 1
      if (msg.ora_perception)            return true; // redclaw-observe Output 1
      if (msg.redclaw_hub_context)       return true; // redclaw-hub (action:"context")
      return false;
    }

    // Devine une étiquette de source lisible si chat_source n'est pas fourni
    function _autoSource(msg) {
      if (msg.redclaw_goal_achieved) return msg.redclaw_goal?.name ? `goal:${msg.redclaw_goal.name}` : "goal";
      if (msg.redclaw_reflect)       return msg.redclaw_reflect.skill ? `reflect:${msg.redclaw_reflect.skill}` : "reflect";
      if (msg.ora_perception)        return "observe";
      if (msg.redclaw_hub_context)   return "hub";
      return "";
    }

    // ── Formatage sorties ────────────────────────────────────────────────────

    function _formatChat(msg) {
      const last = node._conversations.slice(-1)[0] || {};
      return {
        ...msg,
        payload: {
          type:          "chat_update",
          title:         node.uiTitle,
          last_message:  last,
          conversations: node._conversations.slice(-20),
          pending:       node._pending,
          stats: {
            total:     node._conversations.length,
            user:      node._conversations.filter(c => c.role==="user").length,
            assistant: node._conversations.filter(c => c.role==="assistant").length,
          },
        },
        ui_payload: last.content || "",
        ui_role:    last.role    || "",
        ui_ts:      last.ts      || "",
      };
    }

    function _formatAssistance(msg) {
      const last = node._assistance.slice(-1)[0] || {};
      return {
        ...msg,
        payload: {
          type:       "assistance_update",
          title:      node.assistTitle,
          last_item:  last,
          items:      node._assistance.slice(-20),
          stats: {
            total: node._assistance.length,
          },
        },
        ui_payload:  last.content  || "",
        ui_source:   last.source   || "",
        ui_category: last.category || "",
        ui_ts:       last.ts       || "",
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

    function _trimChat() {
      if (node._conversations.length > node.maxHistory) {
        node._conversations = node._conversations.slice(-node.maxHistory);
      }
    }
    function _trimAssistance() {
      if (node._assistance.length > node.maxHistory) {
        node._assistance = node._assistance.slice(-node.maxHistory);
      }
    }

    function _updateStatus() {
      const n = node._conversations.length;
      const a = node._assistance.length;
      node.status({
        fill:  node._pending ? "blue" : "green",
        shape: node._pending ? "ring" : "dot",
        text:  `${n} chat${a ? ` · ${a} assistance` : ""}${node._pending ? " · En attente…" : ""}`,
      });
    }

    node.on("close", () => node.status({}));
  }

  RED.nodes.registerType("neuro-chat", NeuroChatNode);
};
