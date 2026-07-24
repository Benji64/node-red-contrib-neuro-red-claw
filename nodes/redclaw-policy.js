/**
 * neuro-red-claw v2.5 — Policy Node
 *
 * Évalue les actions des agents contre des politiques 100% locales à CE nœud :
 *   - les politiques inline définies dans sa propre configuration
 *   - + celles d'un redclaw-policy-config explicitement référencé (optionnel)
 *
 * v2.5 : plus de singleton global. Avant, tous les nœuds redclaw-policy du
 * déploiement partageaient un même registre — deux nœuds sans AUCUN fil entre
 * eux pouvaient s'influencer via un `scope` qui matchait par coïncidence.
 * Ce nœud n'évalue plus QUE ce qui est visible dans SON propre panneau de
 * configuration : soit inline, soit via une référence nommée explicite —
 * jamais par recherche globale.
 *
 * Framework-agnostic : aucun domaine codé en dur.
 * Position : entre l'Orchestrateur et le MCP Router.
 *
 * ─── Sorties ─────────────────────────────────────────────────────────────────
 *  Output 1 : ALLOWED / PROMOTED      → MCP Router (action autorisée)
 *  Output 2 : RESTRICTED / SUPERVISED → confirmation ou alerte
 *  Output 3 : BLOCKED                 → refus définitif
 *
 * ─── Niveaux d'autorisation ─────────────────────────────────────────────────
 *  4 PROMOTED    : priorité maximale, ressources dédiées
 *  3 ALLOWED     : autorisé normalement
 *  2 SUPERVISED  : autorisé mais journalisé + alerte
 *  1 RESTRICTED  : confirmation humaine requise
 *  0 BLOCKED     : interdit, non négociable
 */

const { evaluate, LEVELS, LEVEL_LABELS } = require("../lib/policy-engine");
const NeuroMessage = require("../lib/neuro-message");

module.exports = function (RED) {
  function RedclawPolicyNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.agentName    = (config.agentName || "").trim();
    node.agentRole    = (config.agentRole || "default").trim();
    node.logDecisions = config.logDecisions !== false;

    // Politiques inline (locales à ce nœud)
    let localPolicies = [];
    try {
      if (config.policies?.trim()) localPolicies = JSON.parse(config.policies);
    } catch (e) {
      node.warn(`[Policy] Politiques JSON invalides : ${e.message}`);
    }
    node._localPolicies = localPolicies;

    // Référence EXPLICITE optionnelle vers un jeu de règles partagé
    // (comme llmConfig dans redclaw-orchestrator) — jamais une recherche globale
    node.policyConfig = config.policyConfig
      ? RED.nodes.getNode(config.policyConfig)
      : null;

    const sharedCount = node.policyConfig?.policies?.length || 0;

    // v2.11 — Détection proactive : si ce nœud peut produire RESTRICTED
    // ou SUPERVISED mais qu'Output 2 n'a AUCUN fil câblé, l'action ne
    // sera JAMAIS traitée — ni autorisée, ni refusée, juste perdue en
    // silence (comportement standard de Node-RED pour une sortie non
    // câblée). v2.12 — neuro-approval (timeout + auto-reject de
    // référence) est inclus dans ce même package depuis la fusion, mais
    // la détection reste utile : rien n'empêche d'oublier de le câbler
    // sur Output 2 dans un flow donné.
    const allDeclaredPolicies = [...localPolicies, ...(node.policyConfig?.policies || [])];
    const hasRestrictedOrSupervised = allDeclaredPolicies.some(
      p => p.active !== false && (p.level === LEVELS.RESTRICTED || p.level === LEVELS.SUPERVISED)
    );
    const output2Wired = (node.wires?.[1]?.length || 0) > 0;

    if (hasRestrictedOrSupervised && !output2Wired) {
      node.warn(
        `[Policy] Une politique RESTRICTED/SUPERVISED est configurée mais Output 2 ` +
        `n'a aucun consommateur câblé — ces actions seront perdues en silence, jamais ` +
        `traitées. Câbler vers neuro-approval (inclus dans ce package) ou un nœud équivalent.`
      );
    }

    node.status({
      fill: hasRestrictedOrSupervised && !output2Wired ? "yellow" : "green",
      shape: hasRestrictedOrSupervised && !output2Wired ? "ring" : "dot",
      text: hasRestrictedOrSupervised && !output2Wired
        ? "⚠️ Output 2 non câblé"
        : `${localPolicies.length} locale(s)${sharedCount ? ` +${sharedCount} partagée(s)` : ""}`,
    });

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };
      if (msg.neuro) NeuroMessage.trace(msg, `policy:${node.name || node.id.slice(0,6)}`, "received");

      const agentName = node.agentName || msg.sessionId || "unknown";
      const tool       = msg.redclaw?.tool || "";

      // Combine local + partagé — TOUJOURS explicite, jamais un lookup global
      const allPolicies = [
        ...node._localPolicies,
        ...(node.policyConfig?.policies || []),
      ];

      const extraCtx = msg.ora_perception?.observations
        ? Object.fromEntries(
            msg.ora_perception.observations.map(o => [`${o.source}_${o.key}`, o.value])
          )
        : {};

      const result = evaluate(msg, allPolicies, {
        agentName, agentRole: node.agentRole, extraCtx,
      });

      if (node.logDecisions) {
        node.warn(
          `[Policy] ${agentName} → ${tool} : ${result.label}` +
          (result.reason ? ` — ${result.reason}` : "") +
          (result.policy ? ` [${result.policy.name}]` : "")
        );
      }

      let outMsg = { ...msg, redclaw_policy: result };
      if (result.modified_params && msg.redclaw) {
        outMsg.redclaw = { ...msg.redclaw, params: result.modified_params };
      }

      if (result.level === LEVELS.BLOCKED) {
        node.status({ fill: "red", shape: "ring", text: `🚫 ${tool}` });
        send([null, null, { ...outMsg, payload: result.reason || `Bloqué : ${tool}` }]);

      } else if (result.level === LEVELS.RESTRICTED || result.level === LEVELS.SUPERVISED) {
        node.status({ fill: "yellow", shape: "ring",
          text: `${result.level === LEVELS.RESTRICTED ? "⏳" : "👁"} ${tool}` });
        send([null, outMsg, null]);

      } else {
        node.status({ fill: "green", shape: "dot",
          text: `${result.level === LEVELS.PROMOTED ? "⚡" : "✓"} ${tool}` });
        send([outMsg, null, null]);
      }

      done();
    });

    node.on("close", () => node.status({}));
  }

  RED.nodes.registerType("redclaw-policy", RedclawPolicyNode);
};
