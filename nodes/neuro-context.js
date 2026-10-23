/**
 * neuro-red-claw — Context Engine
 *
 * Assemble une vue complète avant l'appel skill :
 *   state    : observations courantes (observation-store)
 *   memory   : mémoire pertinente (conversation-memory ou neuro-embed)
 *   tickets  : tickets actifs liés au skill
 *   goals    : objectifs actifs du skill
 *   constraints : contraintes — UNIQUEMENT si un redclaw-policy-config est
 *                 explicitement référencé dans ce nœud (sinon absent, pas
 *                 de recherche globale par nom de skill)
 *
 * Position : entre Hub et Skill (ou entre Skill et Orchestrateur)
 *
 * ─── Câblage ─────────────────────────────────────────────────────────────────
 *  [redclaw-hub] ──► [neuro-context] ──► [redclaw-skill] ──► [redclaw-orchestrator]
 *
 * Le Hub reste simple (routage uniquement).
 * Le Context Engine fait l'assemblage (responsabilité séparée).
 */

const observationStore = require("../lib/observation-store");
const ticketStore      = require("../lib/ticket-store");
const goalStore        = require("../lib/goal-store");
const { createHash }   = require("node:crypto");
const { buildPolicyContext } = require("../lib/policy-engine");
const NeuroMessage     = require("../lib/neuro-message");
const { parseFiniteInteger } = require("../lib/numeric");
const { types } = require("node:util");

module.exports = function (RED) {
  function NeuroContextNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    function readConfigValue(key) {
      if (!config || typeof config !== "object" || types.isProxy(config)) {
        node.warn("[neuro-context] Configuration must be a plain object; using defaults");
        return undefined;
      }
      const descriptor = Object.getOwnPropertyDescriptor(config, key);
      if (!descriptor) return undefined;
      if (!Object.hasOwn(descriptor, "value")) {
        node.warn(`[neuro-context] Configuration "${key}" must be a data property; using its default`);
        return undefined;
      }
      return descriptor.value;
    }
    function readConfigBoolean(key, fallback) {
      const value = readConfigValue(key);
      if (value === undefined) return fallback;
      if (typeof value !== "boolean") {
        node.warn(`[neuro-context] Configuration "${key}" must be a boolean; using its default`);
        return fallback;
      }
      return value;
    }

    node.includeState   = readConfigBoolean("includeState", true);
    node.includeTickets = readConfigBoolean("includeTickets", true);
    node.includeGoals   = readConfigBoolean("includeGoals", true);
    node.includeConstraints = readConfigBoolean("includeConstraints", true);
    const configuredTicketLimit = readConfigValue("ticketLimit");
    const ticketLimit = parseFiniteInteger(configuredTicketLimit);
    node.ticketLimit = ticketLimit !== null && ticketLimit >= 1 && ticketLimit <= 20
      ? ticketLimit
      : 5;
    if (configuredTicketLimit !== undefined && configuredTicketLimit !== "" &&
        (ticketLimit === null || ticketLimit < 1 || ticketLimit > 20)) {
      node.warn('[neuro-context] Configuration "ticketLimit" must be an integer between 1 and 20; using 5');
    }
    const configuredSkillFilter = readConfigValue("skillFilter");
    if (configuredSkillFilter !== undefined && typeof configuredSkillFilter !== "string") {
      node.warn('[neuro-context] Configuration "skillFilter" must be a string; using an empty value');
    }
    node.skillFilter = typeof configuredSkillFilter === "string" ? configuredSkillFilter.trim() : "";

    // v2.5 — référence EXPLICITE, comme llmConfig. Plus de lecture d'un
    // registre global de politiques : si aucun policy-config n'est
    // sélectionné ici, context.constraints reste simplement vide.
    const configuredPolicyId = readConfigValue("policyConfig");
    if (configuredPolicyId !== undefined && typeof configuredPolicyId !== "string") {
      node.warn('[neuro-context] Configuration "policyConfig" must be a string; ignoring the reference');
    }
    node.policyConfig = typeof configuredPolicyId === "string" && configuredPolicyId
      ? RED.nodes.getNode(configuredPolicyId)
      : null;

    node.status({ fill:"green", shape:"dot", text:"Context Engine" });

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      const skillName = node.skillFilter
        || msg.redclaw?.skill?.name
        || msg.redclaw_hub_call?.target
        || msg.sessionId
        || "";

      try {
        const context = {};

        // ── State : observations courantes ───────────────────────────────
        if (node.includeState) {
          context.state = {};
          observationStore.current().forEach(o => {
            context.state[`${o.source}_${o.key}`] = o.value;
          });
        }

        // ── Tickets actifs liés au skill ──────────────────────────────────
        if (node.includeTickets) {
          context.tickets = ticketStore
            .recent(node.ticketLimit, { skill: skillName, status: "running" })
            .map(t => ({ id: t.id, user_message: t.user_message, steps: t.steps }));
        }

        // ── Goals actifs du skill ──────────────────────────────────────────
        if (node.includeGoals) {
          context.goals = goalStore.bySkill(skillName)
            .filter(g => g.status === "active")
            .map(g => ({
              name: g.name, priority: g.priority,
              progress: g.progress, direction: g.direction,
            }));
        }

        // ── Contraintes — UNIQUEMENT depuis le policy-config référencé ──────
        // Pas de recherche globale par skillName : sans référence explicite
        // sélectionnée dans ce nœud, il n'y a simplement rien à afficher ici.
        if (node.includeConstraints && node.policyConfig) {
          context.constraints = {
            policyContext: buildPolicyContext(node.policyConfig.policies, null, null),
          };
        }
        context.provenance = _contextProvenance(context, skillName);

        // ── Enveloppe le message au format standard ─────────────────────
        NeuroMessage.wrap(msg, {
          type:   "skill_request",
          source: "context_engine",
          sessionId: skillName,
        });
        NeuroMessage.enrichContext(msg, context);
        NeuroMessage.trace(msg, "context_engine", "assembled");

        // Construit aussi un résumé textuel pour injection directe LLM
        // Le Context Engine appelle goalStore directement car LUI est le nœud câblé —
        // c'est le fil [Hub]→[neuro-context]→[skill] qui autorise l'influence.
        msg.context_summary = _buildSummary(context);
        if (node.includeGoals) msg.goal_context = goalStore.buildGoalContext(skillName);

        const n = Object.values(context).reduce((s,v) =>
          s + (Array.isArray(v) ? v.length : Object.keys(v||{}).length), 0);
        node.status({ fill:"green", shape:"dot", text:`✓ ${skillName} · ${n} éléments` });

        send([msg, null]);

      } catch (e) {
        node.status({ fill:"red", shape:"ring", text: e.message.slice(0,40) });
        node.error(`[Context Engine] ${e.message}`, msg);
        send([null, { ...msg, payload: e.message }]);
      }

      done();
    });

    function _buildSummary(ctx) {
      const parts = [];
      if (ctx.state && Object.keys(ctx.state).length) {
        parts.push("État : " + Object.entries(ctx.state)
          .map(([k,v]) => `${k}=${v}`).join(", "));
      }
      if (ctx.tickets?.length) {
        parts.push(`Tickets actifs : ${ctx.tickets.length}`);
      }
      if (ctx.goals?.length) {
        parts.push("Objectifs : " + ctx.goals
          .map(g => `${g.name} (${Math.round(g.progress*100)}%)`).join(", "));
      }
      if (ctx.constraints?.policyContext) {
        parts.push(ctx.constraints.policyContext);
      }
      return parts.join("\n");
    }

    function _contextProvenance(context, scope) {
      const sources = {};
      if (Object.hasOwn(context, "state")) sources.state = "observation-store";
      if (Object.hasOwn(context, "tickets")) sources.tickets = "ticket-store";
      if (Object.hasOwn(context, "goals")) sources.goals = "goal-store";
      if (Object.hasOwn(context, "constraints")) sources.constraints = "policy-config";
      const canonicalProvenanceInput = JSON.stringify(_canonicalize({
        context,
        scope,
        sources,
      }));
      const digest = createHash("sha256").update(canonicalProvenanceInput).digest("hex");
      return {
        contextVersion: `sha256:${digest}`,
        schemaVersion: 1,
        scope,
        sources,
      };
    }

    node.on("close", () => node.status({}));
  }

  RED.nodes.registerType("neuro-context", NeuroContextNode);
};

function _canonicalize(value) {
  if (Array.isArray(value)) return value.map(_canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, _canonicalize(value[key])])
  );
}
