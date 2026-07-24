/**
 * neuro-red-claw — Message Standard
 *
 * Format unique pour TOUS les échanges entre nœuds cognitifs.
 * Résout le problème n°1 des systèmes multi-agents : l'incompatibilité des messages.
 *
 * Structure :
 * msg.neuro = {
 *   id       : uuid unique par message
 *   type     : "event" | "skill_request" | "skill_response" | "ticket" | "observation"
 *   source   : "node:id" | "skill:nom" | "hub" | "orchestrator"
 *   intent   : string optionnel ("turn_on_light", "check_temperature"…)
 *   context  : {
 *     state    : {} état courant du système (observations)
 *     memory   : {} mémoire pertinente (courte/active)
 *     tickets  : [] tickets actifs liés
 *     goals    : [] objectifs actifs
 *   }
 *   data     : {} données métier brutes
 *   priority : 0-100 (100 = urgence maximale)
 *   trace    : [{ node, ts, action }] chemin parcouru
 *   sessionId: string
 *   ts       : ISO timestamp
 * }
 */

const { randomUUID } = require("crypto");

class NeuroMessage {

  /**
   * Crée un nouveau message standardisé
   */
  static create(options = {}) {
    return {
      id:        randomUUID().slice(0, 12),
      type:      options.type      || "event",
      source:    options.source    || "unknown",
      intent:    options.intent    || "",
      context: {
        state:   options.context?.state   || {},
        memory:  options.context?.memory  || {},
        tickets: options.context?.tickets || [],
        goals:   options.context?.goals   || [],
      },
      data:      options.data      || {},
      priority:  options.priority  ?? 50,
      trace:     options.trace     || [],
      sessionId: options.sessionId || "",
      ts:        new Date().toISOString(),
    };
  }

  /**
   * Enveloppe un msg Node-RED existant dans le format standard
   * Préserve tout le msg original + ajoute msg.neuro
   */
  static wrap(msg, options = {}) {
    if (msg.neuro?.id) return msg; // déjà enveloppé

    msg.neuro = NeuroMessage.create({
      type:      options.type      || _inferType(msg),
      source:    options.source    || "unknown",
      intent:    options.intent    || "",
      data:      options.data      || { payload: msg.payload },
      priority:  options.priority  ?? 50,
      sessionId: msg.sessionId     || "",
    });
    return msg;
  }

  /**
   * Ajoute une étape dans la trace du message
   */
  static trace(msg, nodeName, action = "") {
    if (!msg.neuro) NeuroMessage.wrap(msg);
    // Copy-on-write : détache TOUJOURS une nouvelle référence de neuro/trace
    // à cet appel précis. Sans ça, deux branches parallèles issues d'un
    // simple {...msg} (mcp-router, redclaw-diverge…) partageraient le même
    // tableau sous-jacent et leurs traces se mélangeraient de façon non
    // déterministe — un outil de debug qui ment est pire que pas d'outil.
    const prevTrace = msg.neuro.trace || [];
    msg.neuro = {
      ...msg.neuro,
      trace: [...prevTrace, {
        node:   nodeName,
        ts:     Date.now(),
        action: action || nodeName,
      }],
    };
    return msg;
  }

  /**
   * Enrichit le contexte du message
   */
  static enrichContext(msg, contextData = {}) {
    if (!msg.neuro) NeuroMessage.wrap(msg);
    // Même garantie que trace() : détache neuro/context plutôt que de muter
    // un objet potentiellement partagé entre branches parallèles.
    msg.neuro = {
      ...msg.neuro,
      context: { ...msg.neuro.context, ...contextData },
    };
    return msg;
  }

  /**
   * Définit le type du message
   */
  static setType(msg, type) {
    if (!msg.neuro) NeuroMessage.wrap(msg);
    msg.neuro = { ...msg.neuro, type };
    return msg;
  }

  /**
   * Retourne un résumé lisible de la trace
   */
  static traceSummary(msg) {
    const trace = msg.neuro?.trace || [];
    return trace.map(t => t.node).join(" → ");
  }

  /**
   * Vérifie si un message est valide
   */
  static isValid(msg) {
    return !!(msg.neuro?.id && msg.neuro?.type && msg.neuro?.ts);
  }

  /**
   * Clone un message en préservant la trace et le contexte
   */
  static clone(msg, overrides = {}) {
    return {
      ...msg,
      neuro: {
        ...(msg.neuro || {}),
        ...overrides,
        trace: [...(msg.neuro?.trace || [])],
        context: {
          ...(msg.neuro?.context || {}),
          ...(overrides.context || {}),
        },
      },
    };
  }
}

const TYPES = {
  EVENT:          "event",
  SKILL_REQUEST:  "skill_request",
  SKILL_RESPONSE: "skill_response",
  TICKET:         "ticket",
  OBSERVATION:    "observation",
  TOOL_CALL:      "tool_call",
  TOOL_RESULT:    "tool_result",
  POLICY_CHECK:   "policy_check",
  DELEGATION:     "delegation",
};

function _inferType(msg) {
  if (msg.redclaw?.tool)          return TYPES.TOOL_CALL;
  if (msg.redclaw?.finalResponse) return TYPES.SKILL_RESPONSE;
  if (msg.redclaw?.skill)         return TYPES.SKILL_REQUEST;
  if (msg.ora_perception)         return TYPES.OBSERVATION;
  if (msg.redclaw_hub)            return TYPES.DELEGATION;
  return TYPES.EVENT;
}

NeuroMessage.TYPES = TYPES;
module.exports = NeuroMessage;
