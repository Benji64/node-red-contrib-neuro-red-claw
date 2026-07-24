/**
 * RedClaw - Agent Orchestrator
 *
 * Deux modes LLM :
 *   INTERNE  : utilise llm-config (Ollama, OpenAI, Anthropic, REST…)
 *   EXTERNE  : envoie le prompt sur Output 3 vers n'importe quel nœud LLM Node-RED
 *              (node-red-contrib-llama-cpp, etc.) et attend la réponse sur Input
 *
 * ─── Entrées ─────────────────────────────────────────────────────────────────
 *  msg.redclaw.userMessage + msg.redclaw.skill  → nouvelle demande
 *  msg.redclaw_call_id (tool)                   → retour MCP Router
 *  msg.redclaw_llm_id  (LLM)                    → retour nœud LLM externe
 *
 * ─── Sorties ─────────────────────────────────────────────────────────────────
 *  Output 1 : tool call      → Security Gate / MCP Router
 *  Output 2 : réponse finale → utilisateur
 *  Output 3 : prompt LLM     → nœud LLM externe (mode externe uniquement)
 */

const { randomUUID }     = require("crypto");
const ConversationMemory = require("../lib/conversation-memory");
const LlmClient          = require("../lib/llm-client");
const ContextRenderer    = require("../lib/context-renderer");
const instrumentation    = require("../lib/instrumentation");
const ticketStore        = require("../lib/ticket-store");
const NeuroMessage       = require("../lib/neuro-message");
// v2.5 — goalStore/skillTrust/longtermMemory retirés : plus d'appel direct sans fil.
// Leur influence ne passe désormais QUE par msg.goal_context / msg.trust_context /
// msg.longterm_context, écrits par des nœuds explicitement câblés en amont
// (redclaw-goal, neuro-trust, neuro-longterm, neuro-context).
const path               = require("path");
const os                 = require("os");

module.exports = function (RED) {
  function AgentOrchestratorNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.llmMode     = config.llmMode     || "internal"; // "internal" | "external"
    node.maxSteps    = parseInt(config.maxSteps,   10) || 5;
    node.maxHistory  = parseInt(config.maxHistory, 10) || 6;
    node.memoryEnabled = config.memoryEnabled !== false;
    node.debugMode   = config.debugMode   === true;
    node.ttlHours    = parseInt(config.ttlHours, 10) || 24;

    // ── LLM interne ──────────────────────────────────────────────────────────
    let llm = null;
    if (node.llmMode === "internal") {
      const llmConfig = RED.nodes.getNode(config.llmConfig);
      if (!llmConfig) {
        node.error("Mode interne : configuration LLM manquante.");
        node.status({ fill:"red", shape:"ring", text:"Config LLM manquante" });
        return;
      }
      llm = llmConfig.client;
    }

    // ── Mémoire ───────────────────────────────────────────────────────────────
    const memDir = config.memoryDir?.trim()
      || path.join(RED.settings.userDir || os.homedir() + "/.node-red", "redclaw-memory");
    node.memory = new ConversationMemory(memDir, {
      maxMessages: node.maxHistory * 4,
      ttlHours:    node.ttlHours,
    });
    const purged = node.memory.purgeExpired();
    if (purged) node.log(`[RedClaw] ${purged} session(s) purgée(s)`);

    // Renderer v1.5 : compression contexte + token budget
    const tokenBudget = parseInt(config.tokenBudget, 10) || 3000;
    node.renderer = new ContextRenderer(tokenBudget);


    // ── Sessions en attente ───────────────────────────────────────────────────
    // tool calls  : callId → { resolve, reject, timer }
    node._toolSessions = new Map();
    // LLM externe : llmId  → { resolve, reject, timer }
    node._llmSessions  = new Map();

    node.status({
      fill:"green", shape:"dot",
      text: node.llmMode === "external"
        ? `Mode externe · ${node.memory.list().length} session(s)`
        : `${llm ? "LLM OK" : "?"} · ${node.memory.list().length} session(s)`,
    });

    // ─── ENTRÉE ───────────────────────────────────────────────────────────────
    node.on("input", async function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };
      // v2.6 — trace passive, seulement si msg.neuro déjà présent
      if (msg.neuro) NeuroMessage.trace(msg, "orchestrator", "received");

      // ── Retour LLM externe ────────────────────────────────────────────────
      if (msg.redclaw_llm_id) {
        const s = node._llmSessions.get(msg.redclaw_llm_id);
        if (s) {
          clearTimeout(s.timer);
          node._llmSessions.delete(msg.redclaw_llm_id);
          // llama-cpp retourne msg.payload = string
          const text = typeof msg.payload === "string"
            ? msg.payload
            : (msg.payload?.content || msg.payload?.message || JSON.stringify(msg.payload));
          s.resolve(text.trim());
        }
        done(); return;
      }

      // ── Retour tool MCP Router ────────────────────────────────────────────
      if (msg.redclaw_call_id) {
        const s = node._toolSessions.get(msg.redclaw_call_id);
        if (s) {
          clearTimeout(s.timer);
          node._toolSessions.delete(msg.redclaw_call_id);
          msg.redclaw_error ? s.reject(new Error(msg.redclaw_error)) : s.resolve(msg.payload);
        }
        done(); return;
      }

      // ── Commandes de contrôle ─────────────────────────────────────────────
      if (msg.redclaw_cmd) { _handleCmd(msg, send); done(); return; }

      // ── Nouvelle demande ──────────────────────────────────────────────────
      const rc = msg.redclaw;
      if (!rc?.userMessage || !rc?.skill) {
        node.warn("[RedClaw] msg.redclaw.userMessage ou msg.redclaw.skill manquant");
        done(); return;
      }

      const { userMessage, skill } = rc;
      const sessionId = msg.sessionId || `${skill.name}-${Date.now().toString(36)}`;

      node.status({ fill:"blue", shape:"dot", text:`[${skill.name}] En cours…` });
      if (node.memoryEnabled) node.memory.addMessage(sessionId, "user", userMessage);

      // v1.5 — démarre le tracking + ticket persistant
      const trace  = instrumentation.start(skill.name, userMessage, sessionId);
      const ticket = ticketStore.create(trace.request_id, skill.name, sessionId, userMessage);
      msg.redclaw_request_id = trace.request_id;

      try {
        const response = await _agentLoop(userMessage, skill, sessionId, msg, send, trace);
        if (node.memoryEnabled) node.memory.addMessage(sessionId, "assistant", response);

        const finished = instrumentation.finish(trace, true);
        ticketStore.complete(ticket, response);
        if (node.debugMode) node.warn(`[RedClaw] ${instrumentation.format(finished)}`);

        node.status({ fill:"green", shape:"dot", text:`[${skill.name}] ✓ ${finished.duration_ms}ms` });

        // Si réponse à une délégation hub → notifie le hub via redclaw_hub_return
        const hubReturn = msg.redclaw_hub_callId
          ? { redclaw_hub_return: { callId: msg.redclaw_hub_callId, result: response } }
          : {};

        send([null, { ...msg, payload:response, sessionId,
          ...hubReturn,
          redclaw:{ userMessage, skill, finalResponse:response, sessionId,
                    success:true, request_id: trace.request_id,
                    ticket_id: ticket?.id }
        }, null]);
      } catch (e) {
        instrumentation.finish(trace, false, e.message);
        ticketStore.fail(ticket, e.message);
        node.status({ fill:"red", shape:"ring", text:e.message.slice(0,40) });
        node.error(`[RedClaw] [${trace?.request_id}] ${e.message}`, msg);
        send([null, null, { ...msg, payload:e.message, sessionId,
          redclaw:{ userMessage, skill, error:e.message, sessionId, success:false,
                    request_id: trace?.request_id }
        }]);
      }
      done();
    });

    // ─── BOUCLE AGENTIQUE ─────────────────────────────────────────────────────
    async function _agentLoop(userMessage, skill, sessionId, origMsg, send, trace) {
      const historyCtx   = node.memoryEnabled ? node.memory.getSummary(sessionId, node.maxHistory) : "";

      // v1.5 — Renderer : compression contexte dans le budget token
      // v1.7 — Enrichit avec les objectifs actifs du skill
      // v2.5 — Toutes ces sources sont des lectures PASSIVES : msg.xxx_context
      // n'existe que si un nœud a été explicitement câblé en amont pour l'écrire
      // (redclaw-goal, neuro-trust:check, neuro-context, neuro-embed, neuro-longterm).
      // Aucune influence ambiante sans fil visible dans le canvas.
      const goalCtx      = origMsg.goal_context     || ""; // redclaw-goal ou neuro-context câblé
      const embedCtx     = origMsg.embed_context    || ""; // neuro-embed câblé
      const contextEngineCtx = origMsg.context_summary || ""; // neuro-context câblé
      const longtermCtx  = origMsg.longterm_context || ""; // neuro-longterm câblé
      const trustCtx      = origMsg.trust_context    || ""; // neuro-trust:check câblé

      // v2.7 — objet structuré : context-renderer applique sa propre priorité
      // de troncature (goals/constraints protégés, historique préservé en
      // dernier recours, enrichissements optionnels sacrifiés en premier).
      // Plus de concaténation aveugle en un seul blob avant troncature.
      const structuredCtx = {
        goals:       goalCtx,
        constraints: contextEngineCtx,
        history:     historyCtx,
        embed:       embedCtx,
        longterm:    longtermCtx,
        trust:       trustCtx,
      };
      const systemPrompt = node.renderer
        ? node.renderer.renderSystem(skill, structuredCtx, { debugMode: node.debugMode })
        : _buildSystem(skill, [historyCtx, goalCtx, embedCtx, contextEngineCtx, longtermCtx, trustCtx]
            .filter(Boolean).join("\n\n")); // fallback simple, sans priorité — utilisé seulement si aucun renderer configuré
      const loopHistory  = [{ role:"user", content:userMessage }];
      let steps = 0;

      while (steps < node.maxSteps) {
        steps++;
        if (node.debugMode) node.warn(`[RedClaw] Étape ${steps}/${node.maxSteps}`);

        const _llmStart = Date.now();
        const raw      = await _callLlm(systemPrompt, _buildPrompt(loopHistory), origMsg, send);
        const _llmDur  = Date.now() - _llmStart;
        if (trace)  instrumentation.recordLlm(trace, systemPrompt, raw, _llmDur);
        if (ticket) ticketStore.addLlmCall(ticket,
          Math.ceil(systemPrompt.length / 4),
          Math.ceil((raw || "").length / 4),
          _llmDur);

        // Log réponse brute — toujours en cas de réponse vide
        if (!raw || !raw.trim()) {
          node.warn("[RedClaw] Réponse LLM vide — vérifier URL/format dans llm-config");
        }
        if (node.debugMode) {
          node.warn(`[RedClaw] LLM → (${raw.length} chars) ${raw.slice(0, 400)}`);
        }

        const decision = _parse(raw);
        if (!decision || decision.action === "respond") return (decision?.message || raw).trim();

        if (decision.action === "tool") {
          const { tool, params } = decision;
          loopHistory.push({ role:"tool_call", content:`"${tool}" params:${JSON.stringify(params||{})}` });
          if (node.memoryEnabled) node.memory.addMessage(sessionId, "tool_call", `"${tool}" params:${JSON.stringify(params||{})}`);

          node.status({ fill:"blue", shape:"dot", text:`→ ${tool} (${steps})` });
          const _toolStart = Date.now();
          let result;
          try {
            result = await _callTool(tool, params, skill.mcpServer, origMsg, send);
            const _toolDur = Date.now() - _toolStart;
            if (trace)  instrumentation.recordTool(trace, tool, true, _toolDur);
            if (ticket) ticketStore.addToolCall(ticket, tool, params, true, _toolDur);
            // v2.5 — plus d'apprentissage fantôme ici. Pour suivre la fiabilité,
            // câbler [neuro-trust: record] sur le retour ⚡ du mcp-router,
            // avant l'entrée de cet orchestrateur. Il lit redclaw_call_started_at
            // (posé ci-dessous dans _callTool) pour calculer la durée lui-même.
          } catch (e) {
            const _toolDur = Date.now() - _toolStart;
            if (trace)  instrumentation.recordTool(trace, tool, false, _toolDur);
            if (ticket) ticketStore.addToolCall(ticket, tool, params, false, _toolDur);
            throw e;
          }
          const resultStr = typeof result === "string" ? result : JSON.stringify(result);

          loopHistory.push({ role:"tool_result", content:`"${tool}": ${resultStr}` });
          if (node.memoryEnabled) node.memory.addMessage(sessionId, "tool_result", `"${tool}": ${resultStr}`);
          continue;
        }
        return raw.trim();
      }

      // Max étapes → synthèse
      const synth = await _callLlm(systemPrompt,
        _buildPrompt([...loopHistory, { role:"user", content:"Résume en une phrase." }]),
        origMsg, send);
      return synth.trim();
    }

    // ─── APPEL LLM ────────────────────────────────────────────────────────────
    async function _callLlm(systemPrompt, userPrompt, origMsg, send) {
      // Mode interne : appel direct via llm-client
      if (node.llmMode === "internal") {
        return await llm.chat(systemPrompt, userPrompt, { temperature:0.1, maxTokens:400 });
      }

      // Mode externe : envoie sur Output 3, attend la réponse sur Input
      return new Promise((resolve, reject) => {
        const llmId = randomUUID();
        const timer = setTimeout(() => {
          node._llmSessions.delete(llmId);
          reject(new Error(`Timeout LLM externe (${node.maxSteps * 15000}ms)`));
        }, node.maxSteps * 15000);

        node._llmSessions.set(llmId, { resolve, reject, timer });

        // Construit le msg pour llama-cpp (mode chat)
        // msg.payload = messages[] OU string selon la config du nœud llama-cpp
        const messages = [
          { role:"system", content:systemPrompt },
          { role:"user",   content:userPrompt   },
        ];

        // Output 3 : vers le nœud LLM externe
        send([null, null, {
          ...origMsg,
          payload:        messages,       // format chat (llama-cpp mode chat)
          redclaw_llm_id: llmId,
          topic:          "llm_request",  // optionnel, pour identifier dans un switch
        }]);
      });
    }

    // ─── APPEL TOOL ───────────────────────────────────────────────────────────
    function _callTool(tool, params, mcpServer, origMsg, send) {
      return new Promise((resolve, reject) => {
        const callId = randomUUID();
        const timer  = setTimeout(() => {
          node._toolSessions.delete(callId);
          reject(new Error(`Timeout tool "${tool}"`));
        }, node.maxSteps * 20000);

        node._toolSessions.set(callId, { resolve, reject, timer });

        send([{ ...origMsg,
          payload:         params || {},
          redclaw:         { ...origMsg.redclaw, tool, params:params||{}, mcpServer },
          redclaw_call_id: callId,
          redclaw_call_started_at: Date.now(), // v2.5 — pour calcul durée par un nœud tap explicite
        }, null, null]);
      });
    }

    // ─── PROMPTS ──────────────────────────────────────────────────────────────
    function _buildSystem(skill, historyCtx) {
      const tools = skill.tools
        ? skill.tools.split(",").map(t => t.trim()).filter(Boolean)
        : [];
      return [
        "Tu es un agent IA. Réponds UNIQUEMENT en JSON valide, sans texte autour.",
        "",
        "Pour appeler un tool :",
        `{"action":"tool","tool":"nom_tool","params":{}}`,
        "",
        "Pour répondre à l'utilisateur :",
        `{"action":"respond","message":"ta réponse"}`,
        "",
        `Skill : ${skill.name}`,
        skill.context      ? `Contexte : ${skill.context}`     : "",
        skill.systemContext? skill.systemContext                : "",
        tools.length       ? `Tools : ${tools.join(", ")}`     : "",
        historyCtx         ? `\n${historyCtx}`                 : "",
      ].filter(Boolean).join("\n");
    }

    function _buildPrompt(history) {
      return history.map(h => {
        switch (h.role) {
          case "user":        return `Demande: ${h.content}`;
          case "tool_call":   return `[Action: ${h.content}]`;
          case "tool_result": return `[Résultat: ${h.content}]`;
          default:            return h.content;
        }
      }).join("\n");
    }

    function _parse(text) {
      try { const d = JSON.parse(text.trim()); if (d.action) return d; } catch (_) {}
      const m = text.match(/\{[\s\S]*?\}/);
      if (m) { try { const d = JSON.parse(m[0]); if (d.action) return d; } catch (_) {} }
      return null;
    }

    // ─── COMMANDES ────────────────────────────────────────────────────────────
    function _handleCmd(msg, send) {
      switch (msg.redclaw_cmd) {
        case "memory_list":   send([null, { ...msg, payload:node.memory.list()                               }, null]); break;
        case "memory_get":    send([null, { ...msg, payload:node.memory.getHistoryForLlm(msg.sessionId, 100) }, null]); break;
        case "memory_clear":  node.memory.clear(msg.sessionId);  send([null, { ...msg, payload:{ cleared:msg.sessionId }}, null]); break;
        case "memory_delete": node.memory.delete(msg.sessionId); send([null, { ...msg, payload:{ deleted:msg.sessionId }}, null]); break;
        case "memory_purge":  const n = node.memory.purgeExpired(); send([null, { ...msg, payload:{ purged:n }}, null]); break;
      }
    }

    node.on("close", function () {
      for (const [,s] of node._toolSessions) { clearTimeout(s.timer); s.reject(new Error("Nœud fermé")); }
      for (const [,s] of node._llmSessions)  { clearTimeout(s.timer); s.reject(new Error("Nœud fermé")); }
      if (node.memory?.destroy) node.memory.destroy();
      node._toolSessions.clear();
      node._llmSessions.clear();
      node.status({});
    });
  }

  // v1.5 — Stats instrumentation
  RED.httpAdmin.get("/redclaw/stats", RED.auth.needsPermission("flows.read"),
    (req, res) => res.json({
      instrumentation: instrumentation.stats(),
      tickets:         ticketStore.stats(),
    })
  );

  // v1.5 — Tickets : liste + détail + historique disque
  RED.httpAdmin.get("/redclaw/tickets", RED.auth.needsPermission("flows.read"),
    (req, res) => {
      const n      = parseInt(req.query.n || "20");
      const skill  = req.query.skill  || null;
      const status = req.query.status || null;
      res.json({
        tickets: ticketStore.recent(n, { skill, status }),
        stats:   ticketStore.stats(),
      });
    }
  );

  RED.httpAdmin.get("/redclaw/tickets/:id", RED.auth.needsPermission("flows.read"),
    (req, res) => {
      const ticket = ticketStore.get(req.params.id);
      if (!ticket) return res.status(404).json({ error: "Ticket introuvable" });
      res.json(ticket);
    }
  );

  RED.httpAdmin.get("/redclaw/tickets/history/disk", RED.auth.needsPermission("flows.read"),
    (req, res) => {
      const n = parseInt(req.query.n || "100");
      res.json({ tickets: ticketStore.loadFromDisk(n) });
    }
  );

  RED.httpAdmin.get("/redclaw/sessions", RED.auth.needsPermission("flows.read"), (req, res) => {
    let mem = null;
    RED.nodes.eachNode(n => {
      if (n.type === "agent-orchestrator" && !mem) {
        const inst = RED.nodes.getNode(n.id);
        if (inst?.memory) mem = inst.memory;
      }
    });
    res.json({ sessions: mem ? mem.list() : [] });
  });

  RED.nodes.registerType("redclaw-orchestrator", AgentOrchestratorNode);
};
