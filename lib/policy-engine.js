/**
 * neuro-red-claw v2.5 — Policy Engine
 *
 * v2.5 : plus de singleton global. `evaluate()` est une fonction PURE —
 * elle ne prend en compte QUE les politiques explicitement passées en
 * paramètre par l'appelant (un nœud redclaw-policy et/ou un config-node
 * redclaw-policy-config explicitement référencé).
 *
 * Avant v2.5, PolicyEngine était exporté comme instance singleton :
 * n'importe quel nœud redclaw-policy posé n'importe où dans le canvas
 * pouvait influencer n'importe quel autre nœud redclaw-policy dont le
 * `scope` matchait — sans AUCUN fil visible entre eux. C'était de
 * l'action à distance, pas un arc réflexe : ce module ne le permet plus.
 *
 * Niveaux d'autorisation :
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

/**
 * Évalue une action contre un jeu de politiques EXPLICITEMENT fourni.
 * Fonction pure — aucun état caché, aucun registre partagé entre appels.
 *
 * @param {object}   msg       message complet (msg.redclaw.tool, params, etc.)
 * @param {object[]} policies  politiques à évaluer — fournies par l'appelant,
 *                             jamais lues depuis un store global implicite
 * @param {object}   options
 *   agentName  : nom de l'agent qui effectue l'action
 *   agentRole  : rôle de l'agent — passé explicitement par l'appelant,
 *                plus de registre global setAgentRole/getAgentRole
 *   extraCtx   : contexte additionnel (observations, état du système)
 *
 * @returns {{
 *   level, label, allowed, requireConfirm, supervised,
 *   reason, policy, modified_params
 * }}
 */
function evaluate(msg, policies, options = {}) {
  const agentName = options.agentName || msg.sessionId || "unknown";
  const role      = options.agentRole || "default";
  const tool      = msg.redclaw?.tool || "";

  const evalCtx = {
    ...(options.extraCtx || {}),
    agent: { name: agentName, role },
    tool,
  };

  const applicable = (policies || [])
    .filter(p => {
      if (!p.active) return false;
      if (!p.scope || p.scope === "all") return true;
      if (p.scope === `agent:${agentName}`) return true;
      if (p.scope === `role:${role}`) return true;
      if (p.scope === `tool:${tool}`) return true;
      return false;
    })
    .sort((a, b) => (b.priority ?? 50) - (a.priority ?? 50));

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

    const level = policy.level ?? LEVELS.ALLOWED;

    let modifiedParams = null;
    if ((level === LEVELS.ALLOWED || level === LEVELS.PROMOTED) && policy.modifyFn) {
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
      level,
      label:          LEVEL_LABELS[level] || "ALLOWED",
      allowed:        level >= LEVELS.ALLOWED,
      requireConfirm: level === LEVELS.RESTRICTED,
      supervised:     level === LEVELS.SUPERVISED,
      reason:         policy.reason || "",
      policy,
      modified_params: modifiedParams,
    };
  }

  // Aucune politique fournie ne matche → ALLOWED par défaut
  return {
    level: LEVELS.ALLOWED, label: "ALLOWED",
    allowed: true, requireConfirm: false, supervised: false,
    reason: "", policy: null, modified_params: null,
  };
}

/**
 * Résumé lisible des politiques fournies, pour injection dans le LLM.
 * Fonction pure — même principe : n'affiche que ce qui est explicitement passé.
 */
function buildPolicyContext(policies, agentName = null, agentRole = null) {
  const ps = (policies || [])
    .filter(p => p.active && (
      !p.scope || p.scope === "all" ||
      (agentRole && p.scope === `role:${agentRole}`) ||
      (agentName && p.scope === `agent:${agentName}`)
    ))
    .sort((a, b) => (b.priority ?? 50) - (a.priority ?? 50));

  if (!ps.length) return "";

  return "Politiques actives :\n" + ps.map(p =>
    `[${LEVEL_LABELS[p.level ?? 3]}|P${p.priority ?? 50}] ${p.name}${p.reason ? " — " + p.reason : ""}`
  ).join("\n");
}

module.exports = { evaluate, buildPolicyContext, LEVELS, LEVEL_LABELS };
