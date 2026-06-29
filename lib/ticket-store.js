/**
 * RedClaw v1.5 — Ticket Store
 *
 * Chaque requête vers un agent crée un ticket persisté sur disque.
 * Format : JSON Lines (.jsonl) — une ligne par ticket, append-only.
 * Audit log immuable : les tickets ne sont jamais modifiés, seulement ajoutés.
 *
 * Structure d'un ticket :
 * {
 *   id          : "a3f8c2d1"          // request_id court
 *   skill       : "domotique-lumiere"
 *   session_id  : "domotique-lumiere"
 *   status      : "running"|"completed"|"failed"
 *   user_message: "Allume le salon"
 *   steps       : []                  // étapes de la boucle agentique
 *   tool_calls  : []                  // { tool, params, success, duration_ms }
 *   llm_calls   : []                  // { tokens_in, tokens_out, duration_ms }
 *   response    : "La lumière..."
 *   error       : null
 *   tokens_in   : 287
 *   tokens_out  : 48
 *   duration_ms : 1240
 *   created_at  : "2025-01-15T14:32:01.000Z"
 *   completed_at: "2025-01-15T14:32:02.240Z"
 * }
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");

class TicketStore {
  /**
   * @param {string} storageDir   dossier de stockage (défaut: ~/.node-red/redclaw-tickets)
   * @param {number} maxTickets   max tickets gardés en mémoire pour les requêtes rapides
   */
  constructor(storageDir, maxTickets = 500) {
    this.storageDir  = storageDir
      || path.join(os.homedir(), ".node-red", "redclaw-tickets");
    this.maxTickets  = maxTickets;
    this._cache      = []; // ring buffer en mémoire
    this._ticketFile = path.join(this.storageDir, "tickets.jsonl");

    this._ensureDir();
    this._loadRecent();
  }

  // ─── Cycle de vie d'un ticket ─────────────────────────────────────────────

  /**
   * Crée un ticket (status: running)
   */
  create(requestId, skillName, sessionId, userMessage) {
    const ticket = {
      id:           requestId,
      skill:        skillName,
      session_id:   sessionId,
      status:       "running",
      user_message: (userMessage || "").slice(0, 500),
      steps:        [],
      tool_calls:   [],
      llm_calls:    [],
      response:     null,
      error:        null,
      tokens_in:    0,
      tokens_out:   0,
      duration_ms:  null,
      created_at:   new Date().toISOString(),
      completed_at: null,
    };
    this._cache.push(ticket);
    if (this._cache.length > this.maxTickets) this._cache.shift();
    return ticket;
  }

  /**
   * Enregistre un appel LLM sur le ticket
   */
  addLlmCall(ticket, tokensIn, tokensOut, durationMs) {
    if (!ticket) return;
    ticket.llm_calls.push({ tokens_in: tokensIn, tokens_out: tokensOut, duration_ms: durationMs });
    ticket.tokens_in  += tokensIn;
    ticket.tokens_out += tokensOut;
    ticket.steps.push(`llm(~${tokensIn}tk)`);
  }

  /**
   * Enregistre un appel tool sur le ticket
   */
  addToolCall(ticket, toolName, params, success, durationMs) {
    if (!ticket) return;
    ticket.tool_calls.push({
      tool:        toolName,
      params:      params || {},
      success,
      duration_ms: durationMs,
    });
    ticket.steps.push(`${toolName}:${success ? "✓" : "✗"}`);
  }

  /**
   * Complète le ticket avec succès et le persiste
   */
  complete(ticket, response) {
    if (!ticket) return;
    ticket.status       = "completed";
    ticket.response     = (response || "").slice(0, 2000);
    ticket.completed_at = new Date().toISOString();
    ticket.duration_ms  = Date.now() - new Date(ticket.created_at).getTime();
    this._persist(ticket);
    return ticket;
  }

  /**
   * Marque le ticket en erreur et le persiste
   */
  fail(ticket, error) {
    if (!ticket) return;
    ticket.status       = "failed";
    ticket.error        = (error || "").slice(0, 500);
    ticket.completed_at = new Date().toISOString();
    ticket.duration_ms  = Date.now() - new Date(ticket.created_at).getTime();
    this._persist(ticket);
    return ticket;
  }

  // ─── Requêtes ─────────────────────────────────────────────────────────────

  /**
   * Retourne les N derniers tickets (depuis le cache mémoire)
   */
  recent(n = 20, filters = {}) {
    let list = [...this._cache].reverse();
    if (filters.skill)  list = list.filter(t => t.skill === filters.skill);
    if (filters.status) list = list.filter(t => t.status === filters.status);
    return list.slice(0, n);
  }

  /**
   * Retourne un ticket par ID
   */
  get(id) {
    return this._cache.find(t => t.id === id) || null;
  }

  /**
   * Stats agrégées sur les N derniers tickets complétés
   */
  stats(n = 50) {
    const completed = this._cache
      .filter(t => t.status === "completed" || t.status === "failed")
      .slice(-n);

    if (!completed.length) return null;

    const success    = completed.filter(t => t.status === "completed").length;
    const avgDur     = Math.round(completed.reduce((s, t) => s + (t.duration_ms || 0), 0) / completed.length);
    const avgTokens  = Math.round(completed.reduce((s, t) => s + (t.tokens_in || 0), 0) / completed.length);

    const toolCount = {};
    completed.forEach(t => (t.tool_calls || []).forEach(c => {
      toolCount[c.tool] = (toolCount[c.tool] || 0) + 1;
    }));
    const topTools = Object.entries(toolCount)
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([t, c]) => `${t}:${c}`).join(", ");

    // Tickets running (en cours)
    const running = this._cache.filter(t => t.status === "running");

    return {
      total:           completed.length,
      running:         running.length,
      success_rate:    `${Math.round(success / completed.length * 100)}%`,
      avg_duration_ms: avgDur,
      avg_tokens_in:   avgTokens,
      top_tools:       topTools || "—",
    };
  }

  /**
   * Lecture des tickets depuis le fichier JSONL (pour relecture historique)
   */
  loadFromDisk(limit = 100) {
    try {
      if (!fs.existsSync(this._ticketFile)) return [];
      const lines = fs.readFileSync(this._ticketFile, "utf8")
        .trim().split("\n").filter(Boolean);
      return lines.slice(-limit).map(l => JSON.parse(l)).reverse();
    } catch (_) { return []; }
  }

  // ─── Persistance ──────────────────────────────────────────────────────────

  _persist(ticket) {
    try {
      fs.appendFileSync(
        this._ticketFile,
        JSON.stringify(ticket) + "\n",
        "utf8"
      );
    } catch (_) {}
  }

  _loadRecent() {
    try {
      if (!fs.existsSync(this._ticketFile)) return;
      const lines = fs.readFileSync(this._ticketFile, "utf8")
        .trim().split("\n").filter(Boolean);
      // Charge les maxTickets derniers tickets en mémoire
      this._cache = lines.slice(-this.maxTickets)
        .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
        .filter(Boolean);
    } catch (_) {}
  }

  _ensureDir() {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  /**
   * Rotation : garde les N derniers tickets dans le fichier JSONL
   * À appeler périodiquement si le fichier grossit trop
   */
  rotate(keepLast = 1000) {
    try {
      if (!fs.existsSync(this._ticketFile)) return 0;
      const lines = fs.readFileSync(this._ticketFile, "utf8")
        .trim().split("\n").filter(Boolean);
      if (lines.length <= keepLast) return 0;
      const trimmed = lines.slice(-keepLast);
      fs.writeFileSync(this._ticketFile, trimmed.join("\n") + "\n", "utf8");
      return lines.length - keepLast;
    } catch (_) { return 0; }
  }
}

// Singleton partagé entre tous les orchestrateurs du même process
const instance = new TicketStore();
module.exports = instance;
module.exports.TicketStore = TicketStore;
