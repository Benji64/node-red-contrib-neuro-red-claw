/**
 * neuro-red-claw — Long-term Memory
 *
 * Mémoire d'habitudes/patterns qui survit au sliding window.
 * Différent de neuro-embed (recherche sémantique sur conversations) :
 * ici on garde des FAITS DISTILLÉS renforcés par répétition.
 *
 * ─── Modes ────────────────────────────────────────────────────────────────────
 *  "record" : enregistre/renforce un souvenir (msg.payload = contenu texte)
 *  "query"  : retourne le contexte long-terme pour un skill
 *  "auto"   : lit msg.longterm_action ("record"|"query")
 *
 * ─── Câblage type ─────────────────────────────────────────────────────────────
 *
 *  Apprentissage depuis la réflexion :
 *  [redclaw-reflect] Output2 ──► [neuro-longterm: record]
 *
 *  Injection dans l'orchestrateur :
 *  [neuro-longterm: query] ──► [redclaw-orchestrator]
 *  msg.longterm_context est lu automatiquement par l'orchestrateur
 */

const longtermMemory = require("../lib/longterm-memory");

module.exports = function (RED) {
  function NeuroLongtermNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.mode      = config.mode      || "query";
    node.skillName = (config.skillName || "").trim();
    node.memType   = config.memType   || "pattern";
    node.limit     = parseInt(config.limit, 10) || 5;

    node.status({ fill:"green", shape:"dot",
      text:`${longtermMemory.all().length} souvenir(s)` });

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      const skillName = node.skillName || msg.sessionId || msg.reflect_skill || "";
      const action     = msg.longterm_action || node.mode;

      try {
        if (action === "record") {
          // Accepte soit un texte simple, soit des prescriptions de redclaw-reflect
          const items = Array.isArray(msg.payload)
            ? msg.payload.map(p => p.suggestion || p.description || String(p))
            : [String(msg.payload)];

          const recorded = items
            .filter(Boolean)
            .map(text => longtermMemory.record(skillName, node.memType, text, { source:"flow" }));

          node.status({ fill:"green", shape:"dot",
            text:`✓ ${recorded.length} enregistré(s)` });
          send([{ ...msg, payload: recorded }, null]);

        } else if (action === "query") {
          const context = longtermMemory.buildContext(skillName, node.limit);
          node.status({ fill:"green", shape:"dot",
            text:`${longtermMemory.bySkill(skillName).length} pour "${skillName}"` });

          send([{
            ...msg,
            longterm_context: context, // lu automatiquement par redclaw-orchestrator
            longterm_items:   longtermMemory.bySkill(skillName),
          }, null]);

        } else {
          node.warn(`[neuro-longterm] Action inconnue : ${action}`);
        }
      } catch (e) {
        node.error(`[neuro-longterm] ${e.message}`, msg);
        send([null, { ...msg, payload: e.message }]);
      }

      done();
    });

    node.on("close", () => node.status({}));
  }

  RED.httpAdmin.get("/redclaw/longterm", RED.auth.needsPermission("flows.read"),
    (req, res) => {
      const skill = req.query.skill;
      res.json({ memories: skill ? longtermMemory.bySkill(skill) : longtermMemory.all() });
    }
  );

  RED.nodes.registerType("neuro-longterm", NeuroLongtermNode);
};
