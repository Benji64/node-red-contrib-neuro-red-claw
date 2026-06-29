/**
 * RedClaw v1.9 — Policy Node
 *
 * Évalue les actions des agents contre les politiques définies.
 * Framework-agnostic : aucun domaine codé en dur.
 * Place entre l'Orchestrateur et le MCP Router.
 *
 * ─── Sorties ─────────────────────────────────────────────────────────────────
 *  Output 1 : ALLOWED / PROMOTED    → MCP Router (action autorisée)
 *  Output 2 : RESTRICTED / SUPERVISED → confirmation ou alerte
 *  Output 3 : BLOCKED               → refus définitif
 *
 * ─── Niveaux d'autorisation ─────────────────────────────────────────────────
 *  4 PROMOTED    : priorité maximale, ressources dédiées
 *  3 ALLOWED     : autorisé normalement
 *  2 SUPERVISED  : autorisé mais journalisé + alerte
 *  1 RESTRICTED  : confirmation humaine requise
 *  0 BLOCKED     : interdit, non négociable
 */

const { PolicyEngine, LEVELS, LEVEL_LABELS } = require("../lib/policy-engine");
const policyEngine = require("../lib/policy-engine");

module.exports = function (RED) {
  function RedclawPolicyNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.agentName  = (config.agentName || "").trim();
    node.agentRole  = (config.agentRole || "default").trim();
    node.logDecisions = config.logDecisions !== false;

    // Compile les politiques depuis la config
    let policies = [];
    try {
      if (config.policies?.trim()) {
        policies = JSON.parse(config.policies);
      }
    } catch (e) {
      node.warn(`[Policy] Politiques JSON invalides : ${e.message}`);
    }

    // Enregistre les politiques dans le moteur singleton
    // Chaque nœud enregistre SES politiques avec un préfixe nodeId
    node._policyIds = [];
    policies.forEach(p => {
      const registered = policyEngine.addPolicy({
        ...p,
        id: `${node.id}_${p.id || Date.now().toString(36)}`,
      });
      node._policyIds.push(registered.id);
    });

    // Enregistre le rôle de l'agent
    if (node.agentName && node.agentRole) {
      policyEngine.setAgentRole(node.agentName, node.agentRole);
    }

    const n = node._policyIds.length;
    node.status({ fill: "green", shape: "dot", text: `${n} politique(s)` });

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      const agentName = node.agentName || msg.sessionId || "unknown";
      const tool      = msg.redclaw?.tool || "";

      // Évalue l'action
      const result = policyEngine.evaluate(msg, {
        agentName,
        extraCtx: msg.ora_perception?.observations
          ? Object.fromEntries(
              msg.ora_perception.observations.map(o => [`${o.source}_${o.key}`, o.value])
            )
          : {},
      });

      if (node.logDecisions) {
        node.warn(
          `[Policy] ${agentName} → ${tool} : ${result.label}` +
          (result.reason ? ` — ${result.reason}` : "") +
          (result.policy ? ` [${result.policy.name}]` : "")
        );
      }

      // Met à jour les params si modifiés par une politique
      let outMsg = { ...msg, redclaw_policy: result };
      if (result.modified_params && msg.redclaw) {
        outMsg.redclaw = { ...msg.redclaw, params: result.modified_params };
      }

      // Route selon le niveau
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

    node.on("close", function () {
      // Retire les politiques enregistrées par ce nœud
      node._policyIds.forEach(id => policyEngine.removePolicy(id));
      node.status({});
    });
  }

  // Endpoint REST pour voir les politiques actives
  RED.httpAdmin.get("/redclaw/policies",
    RED.auth.needsPermission("flows.read"),
    (req, res) => res.json({
      policies: policyEngine.allPolicies(),
      levels:   LEVEL_LABELS,
    })
  );

  RED.nodes.registerType("redclaw-policy", RedclawPolicyNode);
};
