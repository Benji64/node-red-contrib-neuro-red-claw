/**
 * neuro-red-claw — Envelope
 *
 * Standardise les messages dans le format neuro-red-claw.
 * Ajoute msg.neuro = { id, type, source, intent, context, data, priority, trace }
 * Trace automatiquement le chemin du message à chaque passage.
 *
 * ─── Modes ────────────────────────────────────────────────────────────────────
 *  "wrap"    : enveloppe msg.payload dans msg.neuro (entrée système)
 *  "unwrap"  : extrait msg.neuro.data vers msg.payload (sortie système)
 *  "trace"   : ajoute juste une étape de trace, passe le message
 *  "validate": vérifie que le message est bien formaté
 *
 * ─── Position dans le flow ────────────────────────────────────────────────────
 *  En entrée : [Source externe] ──► [neuro-envelope: wrap] ──► [redclaw-skill]
 *  En sortie : [redclaw-orchestrator] ──► [neuro-envelope: unwrap] ──► [Dashboard]
 *  Partout   : [nœud A] ──► [neuro-envelope: trace] ──► [nœud B]
 */

const NeuroMessage = require("../lib/neuro-message");

module.exports = function (RED) {
  function NeuroEnvelopeNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.mode      = config.mode     || "wrap";
    node.nodeName  = (config.nodeName || config.name || "envelope").trim();
    node.msgType   = config.msgType  || "event";
    node.source    = (config.source  || "").trim();
    node.intent    = (config.intent  || "").trim();
    node.priority  = parseInt(config.priority, 10) || 50;
    node.strict    = config.strict   === true;

    node.status({ fill:"green", shape:"dot",
      text:`${node.mode} · ${node.msgType}` });

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      switch (node.mode) {

        // ── Wrap : enveloppe dans le format standard ────────────────────
        case "wrap": {
          NeuroMessage.wrap(msg, {
            type:      node.msgType,
            source:    node.source || `node:${node.id.slice(0,8)}`,
            intent:    node.intent || (msg.topic || ""),
            data:      { payload: msg.payload, topic: msg.topic },
            priority:  msg.priority ?? node.priority,
            sessionId: msg.sessionId || "",
          });
          NeuroMessage.trace(msg, node.nodeName, "wrap");
          send([msg, null]);
          break;
        }

        // ── Unwrap : extrait les données du format standard ─────────────
        case "unwrap": {
          if (msg.neuro?.data?.payload !== undefined) {
            msg.payload = msg.neuro.data.payload;
          }
          NeuroMessage.trace(msg, node.nodeName, "unwrap");
          const summary = NeuroMessage.traceSummary(msg);
          node.status({ fill:"green", shape:"dot",
            text:`✓ ${msg.neuro?.trace?.length || 0} étapes` });
          if (node.strict) node.log(`[trace] ${summary}`);
          send([msg, null]);
          break;
        }

        // ── Trace : ajoute juste une étape ─────────────────────────────
        case "trace": {
          NeuroMessage.trace(msg, node.nodeName, node.intent || "pass");
          send([msg, null]);
          break;
        }

        // ── Validate : vérifie + route selon validité ───────────────────
        case "validate": {
          if (NeuroMessage.isValid(msg)) {
            NeuroMessage.trace(msg, node.nodeName, "validated");
            send([msg, null]);
          } else {
            node.warn(`[neuro-envelope] Message invalide — pas de msg.neuro`);
            send([null, msg]); // Output 2 : invalide
          }
          break;
        }

        default:
          node.warn(`[neuro-envelope] Mode inconnu : ${node.mode}`);
          send([msg, null]);
      }

      done();
    });

    node.on("close", () => node.status({}));
  }

  RED.nodes.registerType("neuro-envelope", NeuroEnvelopeNode);
};
