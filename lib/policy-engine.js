/**
 * RedClaw v1.9 — Policy Engine
 *
 * Évalue les politiques de comportement des agents.
 * Framework-agnostic : aucun domaine codé en dur.
 * Le domaine est défini par le package qui utilise RedClaw.
 *
 * Niveaux d'autorisation (inspirés des systèmes de contrôle d'accès) :
 *
 *   LEVEL 0 — BLOCKED    : action interdite, non négociable
 *   LEVEL 1 — RESTRICTED : action nécessite confirmation humaine
 *   LEVEL 2 — SUPERVISED : action autorisée mais journalisée avec alerte
 *   LEVEL 3 — ALLOWED    : action autorisée normalement
 *   LEVEL 4 — PROMOTED   : action prioritaire, ressources dédiées
 *
 * Structure d'une politique :
 * {
 *   id         : "pol_001"
 *   name       : "Description lisible"
 *   condition  : "expression JS — msg, context, agent accessibles"
 *   level      : 0..4
 *   reason     : "Pourquoi cette règle existe"
 *   priority   : 1..100  (100 = évalué en premier)
 *   scope      : "all" | "agent:<nom>" | "role:<role>" | "tool:<nom>"
 *   active     : true/false
 *   modifyFn   : code JS pour modifier les params (level 3/4 seulement)
 * }
 */

const LEVELS = {
  BLOCKED:    0,
  RESTRICTED: 1,
  SUPERVISED: 2,
  ALLOWED:    3,
  PROMOTED:   4,
};

const LEVEL_LABELS = {
  0: "BLOCKED",
  1: "RESTRICTED",
  2: "SUPERVISED",
  3: "ALLOWED",
  4: "PROMOTED",
};

class PolicyEngine {
  constructor() {
    this._policies  = new Map();
    this._context   = {}; // variables globales accessibles dans les conditions
    this._agentRoles= new Map(); // agentName → role
  }

  // ─── Configuration ────────────────────────────────────────────────────────

  setContext(ctx)              { Object.assign(this._context, ctx); }
  setAgentRole(agent, role)    { this._agentRoles.set(agent, role); }
  getAgentRole(agent)          { return this._agentRoles.get(agent) || "default"; }

  addPolicy(policy) {
    const p = {
      priority:  50,
      scope:     "all",
      level:     LEVELS.ALLOWED,
      active:    true,
      modifyFn:  null,
      reason:    "",
      ...policy,
      id: policy.id || `pol_${Date.now().toString(36)}`,
    };
    this._policies.set(p.id, p);
    return p;
  }

  removePolicy(id)  { this._policies.delete(id); }
  getPolicy(id)     { return this._policies.get(id) || null; }
  allPolicies()     { return [...this._policies.values()]; }

  // ─── Évaluation ──────────────────────────────────────────────────────────

  /**
   * Évalue une action et retourne le niveau d'autorisation.
   *
   * @param {object} msg      message complet (msg.redclaw.tool, params, etc.)
   * @param {object} options
   *   agentName  : nom de l'agent qui effectue l'action
   *   extraCtx   : contexte additionnel (observations, état du système)
   *
   * @returns {{
   *   level         : 0..4,
   *   label         : string,
   *   allowed       : boolean,
   *   requireConfirm: boolean,
   *   supervised    : boolean,
   *   reason        : string,
   *   policy        : object|null,
   *   modified_params: object|null
   * }}
   */
  evaluate(msg, options = {}) {
    const agentName = options.agentName || msg.sessionId || "unknown";
    const role      = this.getAgentRole(agentName);
    const tool      = msg.redclaw?.tool || "";

    const evalCtx = {
      ...this._context,
      ...(options.extraCtx || {}),
      agent: { name: agentName, role },
      tool,
    };

    // Filtre et trie les politiques applicables
    const applicable = this.allPolicies()
      .filter(p => {
        if (!p.active) return false;
        if (p.scope === "all") return true;
        if (p.scope === `agent:${agentName}`) return true;
        if (p.scope === `role:${role}`) return true;
        if (p.scope === `tool:${tool}`) return true;
        return false;
      })
      .sort((a, b) => b.priority - a.priority);

    // Évalue chaque politique dans l'ordre de priorité
    for (const policy of applicable) {
      if (!policy.condition) continue;

      let conditionMet = false;
      try {
        const fn = new Function("msg", "context", "agent", `
          try { return !!(${policy.condition}); }
          catch(_) { return false; }
        `);
        conditionMet = fn(msg, evalCtx, evalCtx.agent);
      } catch (_) { continue; }

      if (!conditionMet) continue;

      // Politique matchée
      let modifiedParams = null;
      if ((policy.level === LEVELS.ALLOWED || policy.level === LEVELS.PROMOTED)
          && policy.modifyFn) {
        try {
          const fn = new Function("msg", "context", "params", `
            try { ${policy.modifyFn} }
            catch(_) {}
            return params;
          `);
          modifiedParams = fn(msg, evalCtx, { ...(msg.redclaw?.params || {}) });
        } catch (_) {}
      }

      return {
        level:          policy.level,
        label:          LEVEL_LABELS[policy.level] || "ALLOWED",
        allowed:        policy.level >= LEVELS.ALLOWED,
        requireConfirm: policy.level === LEVELS.RESTRICTED,
        supervised:     policy.level === LEVELS.SUPERVISED,
        reason:         policy.reason,
        policy,
        modified_params: modifiedParams,
      };
    }

    // Aucune politique → ALLOWED par défaut
    return {
      level: LEVELS.ALLOWED, label: "ALLOWED",
      allowed: true, requireConfirm: false, supervised: false,
      reason: "", policy: null, modified_params: null,
    };
  }

  /**
   * Résumé des politiques actives pour injection dans le LLM
   */
  buildPolicyContext(agentName = null) {
    const role = agentName ? this.getAgentRole(agentName) : null;
    const ps   = this.allPolicies()
      .filter(p => p.active && (
        p.scope === "all" ||
        (role && p.scope === `role:${role}`) ||
        (agentName && p.scope === `agent:${agentName}`)
      ))
      .sort((a, b) => b.priority - a.priority);

    if (!ps.length) return "";

    return "Politiques actives :\n" + ps.map(p =>
      `[${LEVEL_LABELS[p.level]}|P${p.priority}] ${p.name}${p.reason ? " — " + p.reason : ""}`
    ).join("\n");
  }
}

// Constantes exportées
PolicyEngine.LEVELS       = LEVELS;
PolicyEngine.LEVEL_LABELS = LEVEL_LABELS;

const instance = new PolicyEngine();
module.exports = instance;
module.exports.PolicyEngine = PolicyEngine;
module.exports.LEVELS       = LEVELS;
module.exports.LEVEL_LABELS = LEVEL_LABELS;
