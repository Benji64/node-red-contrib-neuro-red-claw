/**
 * neuro-red-claw — Trust
 *
 * Mémoire sémantique de fiabilité. v2.5 : 100% câblage explicite.
 * Aucun apprentissage ni aucune injection ne se produit sans un fil visible
 * dans le canvas — exactement comme un arc réflexe biologique : court,
 * mais toujours une vraie synapse physique, jamais une influence ambiante.
 *
 * ─── Modes ────────────────────────────────────────────────────────────────────
 *
 *  "record" : TAP passthrough sur le chemin de retour d'un tool call.
 *             Lit msg.redclaw.tool, msg.sessionId, msg.redclaw_error,
 *             msg.redclaw_call_started_at (posé par l'orchestrateur à l'aller).
 *             Enregistre puis relaie le msg INCHANGÉ — n'interrompt jamais le flux.
 *
 *             [redclaw-orchestrator] Output1 (stamp redclaw_call_started_at)
 *                   → [security-gate] → [policy] → [mcp-router] → [adapter] → [tool]
 *                   → [adapter] → [mcp-router] ⚡
 *                   → [neuro-trust: record]   ← TAP ICI, sur le fil de retour
 *                   → [redclaw-orchestrator] entrée
 *
 *  "check"  : lit la confiance d'un tool AVANT exécution, écrit msg.trust_context
 *             (lu passivement par l'orchestrateur SI ce nœud est câblé en amont).
 *             Output 1 = confiance OK · Output 2 = sous le seuil (à confirmer)
 *
 *  "view"   : retourne tous les scores (debug/dashboard, déclenché par l'utilisateur)
 *  "reset"  : réinitialise la confiance d'un tool (déclenché par l'utilisateur)
 */

const skillTrust = require("../lib/skill-trust");

module.exports = function (RED) {
  function NeuroTrustNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.mode      = config.mode      || "check";
    node.threshold = parseFloat(config.threshold) || 0.7;
    node.alertOnFailure = config.alertOnFailure !== false;

    node.status({ fill:"green", shape:"dot",
      text:`${node.mode} · ${skillTrust.all().length} tool(s) suivis` });

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      switch (node.mode) {

        // ── RECORD : tap sur le chemin de retour, passthrough obligatoire ───
        case "record": {
          const skillName = msg.sessionId || msg.redclaw?.skill?.name || "";
          const toolName  = msg.redclaw?.tool || "";
          const success   = !msg.redclaw_error;
          const startedAt = msg.redclaw_call_started_at;
          const duration  = startedAt ? Date.now() - startedAt : 0;

          if (!toolName) {
            // Rien à enregistrer (pas un retour de tool call) — relaie tel quel
            send([msg, null]); done(); return;
          }

          const trust = skillTrust.record(skillName, toolName, success, duration,
            success ? null : msg.redclaw_error);

          node.status({ fill: trust.trustScore < node.threshold ? "yellow" : "green",
            shape:"dot", text:`${toolName}: ${Math.round(trust.trustScore*100)}%` });

          // Output 1 : TOUJOURS relayer le msg inchangé — ce nœud est un tap,
          // pas un filtre. L'orchestrateur en aval doit recevoir le retour.
          send([msg, null]);

          // Output 2 : alerte optionnelle si cet appel vient d'échouer
          // ET que la confiance résultante est sous le seuil
          if (node.alertOnFailure && !success && trust.trustScore < node.threshold) {
            send([null, {
              ...msg,
              payload: `Confiance dégradée : ${toolName} (${Math.round(trust.trustScore*100)}%) — ${msg.redclaw_error}`,
              redclaw_trust: trust,
            }]);
          }
          break;
        }

        // ── CHECK : lecture avant action, écrit trust_context (passif) ──────
        case "check": {
          const skillName = msg.redclaw?.skill?.name || msg.sessionId || "";
          const toolName  = msg.redclaw?.tool || "";
          const trust     = toolName ? skillTrust.getTrust(skillName, toolName) : null;

          msg.redclaw_trust = trust || { trustScore: 1, totalCalls: 0, tool: toolName };
          // Lu passivement par redclaw-orchestrator UNIQUEMENT si ce nœud
          // est câblé en amont sur son chemin d'entrée
          msg.trust_context = skillTrust.buildTrustContext(skillName);

          const score = msg.redclaw_trust.trustScore;
          node.status({ fill: score < node.threshold ? "yellow" : "green", shape:"dot",
            text:`${toolName || skillName}: ${Math.round(score*100)}%` });

          if (trust && score < node.threshold && trust.totalCalls >= 3) {
            send([null, msg]); // Output 2 : sous le seuil → confirmation recommandée
          } else {
            send([msg, null]); // Output 1 : OK → continue
          }
          break;
        }

        case "view": {
          const skillName = msg.payload?.skill || msg.sessionId || null;
          const data = skillName ? skillTrust.getSkillTrust(skillName) : skillTrust.all();
          send([{ ...msg, payload: data }, null]);
          break;
        }

        case "reset": {
          const { skill, tool } = msg.payload || {};
          skillTrust.reset(skill, tool);
          node.status({ fill:"grey", shape:"ring", text:`reset ${tool}` });
          send([{ ...msg, payload: { reset: true, skill, tool } }, null]);
          break;
        }

        default:
          node.warn(`[neuro-trust] Mode inconnu : ${node.mode}`);
          send([msg, null]);
      }

      done();
    });

    node.on("close", () => node.status({}));
  }

  RED.httpAdmin.get("/redclaw/trust", RED.auth.needsPermission("flows.read"),
    (req, res) => {
      const skill = req.query.skill;
      res.json({ trust: skill ? skillTrust.getSkillTrust(skill) : skillTrust.all() });
    }
  );

  RED.nodes.registerType("neuro-trust", NeuroTrustNode);
};
