/**
 * RedClaw v1.5 — Instrumentation
 *
 * Suivi léger des requêtes sans infrastructure externe.
 * Fonctionne en mémoire + logs structurés Node-RED.
 *
 * Métriques collectées par requête :
 *   - request_id  : UUID unique propagé dans tout le pipeline
 *   - skill       : skill utilisé
 *   - steps       : nombre d'aller-retours LLM
 *   - tool_calls  : tools appelés + succès/échec
 *   - llm_tokens  : estimation tokens envoyés/reçus
 *   - duration_ms : durée totale
 *   - success     : true/false
 */

const { randomUUID } = require("crypto");

class Instrumentation {
  constructor(maxEntries = 200) {
    this.maxEntries = maxEntries;
    this._history   = []; // ring buffer des N dernières requêtes
  }

  /**
   * Démarre le tracking d'une nouvelle requête
   * @returns {object} trace — à passer dans le pipeline
   */
  start(skillName, userMessage, sessionId) {
    const trace = {
      request_id:  randomUUID().slice(0, 8), // ID court pour les logs
      skill:       skillName,
      session_id:  sessionId,
      user_message: userMessage.slice(0, 100),
      started_at:  Date.now(),
      steps:       0,
      tool_calls:  [],        // [{ tool, success, duration_ms }]
      llm_calls:   [],        // [{ tokens_in, tokens_out, duration_ms }]
      success:     null,
      error:       null,
    };
    return trace;
  }

  /**
   * Enregistre un appel LLM
   */
  recordLlm(trace, systemPrompt, response, durationMs) {
    if (!trace) return;
    trace.steps++;
    trace.llm_calls.push({
      tokens_in:   Math.ceil((systemPrompt || "").length / 4),
      tokens_out:  Math.ceil((response     || "").length / 4),
      duration_ms: durationMs,
    });
  }

  /**
   * Enregistre un appel tool
   */
  recordTool(trace, toolName, success, durationMs) {
    if (!trace) return;
    trace.tool_calls.push({ tool: toolName, success, duration_ms: durationMs });
  }

  /**
   * Termine le tracking et sauvegarde dans l'historique
   */
  finish(trace, success, error = null) {
    if (!trace) return null;
    trace.success     = success;
    trace.error       = error;
    trace.duration_ms = Date.now() - trace.started_at;

    // Calcul résumé
    trace.total_tokens_in  = trace.llm_calls.reduce((s, c) => s + c.tokens_in,  0);
    trace.total_tokens_out = trace.llm_calls.reduce((s, c) => s + c.tokens_out, 0);
    trace.tool_success_rate = trace.tool_calls.length
      ? trace.tool_calls.filter(t => t.success).length / trace.tool_calls.length
      : null;

    // Sauvegarde dans le ring buffer
    this._history.push({ ...trace });
    if (this._history.length > this.maxEntries) {
      this._history.shift();
    }

    return trace;
  }

  /**
   * Retourne un résumé formaté pour les logs Node-RED
   */
  format(trace) {
    if (!trace) return "";
    const tools = trace.tool_calls.map(t => `${t.tool}:${t.success?"✓":"✗"}`).join(" ");
    return [
      `[${trace.request_id}]`,
      `skill:${trace.skill}`,
      `${trace.steps}llm`,
      tools ? `tools:[${tools}]` : "",
      `~${trace.total_tokens_in}tk`,
      `${trace.duration_ms}ms`,
      trace.success ? "✓" : `✗ ${trace.error?.slice(0, 40) || "err"}`,
    ].filter(Boolean).join(" ");
  }

  /**
   * Stats agrégées sur les N dernières requêtes
   */
  stats(n = 50) {
    const recent = this._history.slice(-n);
    if (!recent.length) return null;

    const success  = recent.filter(r => r.success).length;
    const avgDur   = Math.round(recent.reduce((s, r) => s + (r.duration_ms || 0), 0) / recent.length);
    const avgTok   = Math.round(recent.reduce((s, r) => s + (r.total_tokens_in || 0), 0) / recent.length);
    const avgSteps = (recent.reduce((s, r) => s + (r.steps || 0), 0) / recent.length).toFixed(1);

    const toolUsage = {};
    recent.forEach(r => (r.tool_calls || []).forEach(t => {
      toolUsage[t.tool] = (toolUsage[t.tool] || 0) + 1;
    }));

    return {
      total:          recent.length,
      success_rate:   `${Math.round(success / recent.length * 100)}%`,
      avg_duration_ms: avgDur,
      avg_tokens_in:   avgTok,
      avg_steps:       avgSteps,
      top_tools:       Object.entries(toolUsage)
                         .sort((a, b) => b[1] - a[1])
                         .slice(0, 5)
                         .map(([t, c]) => `${t}:${c}`)
                         .join(", "),
    };
  }

  /**
   * Retourne les N dernières traces
   */
  recent(n = 20) {
    return this._history.slice(-n).reverse();
  }

  /**
   * Injecte request_id dans un msg Node-RED
   */
  inject(msg, trace) {
    if (!trace || !msg) return msg;
    msg.redclaw_request_id = trace.request_id;
    return msg;
  }
}

// Singleton — partagé entre tous les orchestrateurs du même process
const instance = new Instrumentation();
module.exports = instance;
module.exports.Instrumentation = Instrumentation;
