/**
 * RedClaw v2.1 — Diverge
 *
 * Pensée divergente : envoie le même signal sur N sorties simultanément,
 * chacune avec un "cadrage cognitif" différent (lens).
 * Attend les N réponses puis les agrège sur la sortie ⚡.
 *
 * Même pattern que mcp-router mais pour les perspectives cognitives.
 *
 * ─── Câblage ─────────────────────────────────────────────────────────────────
 *  [Signal] ──► [redclaw-diverge]
 *    ├─ 1 ──► [skill: angle A] ──► [Orch A] Output2 ──► [diverge] entrée
 *    ├─ 2 ──► [skill: angle B] ──► [Orch B] Output2 ──► [diverge] entrée
 *    ├─ 3 ──► [skill: angle C] ──► [Orch C] Output2 ──► [diverge] entrée
 *    └─ ⚡ ──► [synthèse / décision]
 *
 * ─── Sorties ─────────────────────────────────────────────────────────────────
 *  1..N  → une par "lens" (cadrage cognitif) configuré
 *  N+1   → ⚡ agrégation de toutes les réponses
 *
 * ─── msg enrichi sur chaque sortie ──────────────────────────────────────────
 *  msg.redclaw_lens  = { id, name, prompt, index }
 *  msg.redclaw_diverge_id = identifiant de cette session divergente
 */

const { randomUUID } = require("crypto");

module.exports = function (RED) {
  function RedclawDivergeNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.lenses   = (config.lenses || []).filter(l => l.name);
    node.timeout  = parseInt(config.timeout, 10) || 30000;
    node.strategy = config.strategy || "wait_all"; // wait_all | first_wins | majority

    // Index lens name → index de sortie
    node._idx    = {};
    node.lenses.forEach((l, i) => { node._idx[l.name] = i; });
    node._total  = node.lenses.length + 1;
    node._retour = node.lenses.length;

    // Sessions divergentes en attente : divergeId → { pending Set, responses [], resolve, reject, timer }
    node._sessions = new Map();

    node.status({ fill: "green", shape: "dot",
      text: node.lenses.map(l => l.name).join(" · ") || "Aucun lens" });

    node.on("input", async function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      // ── Retour d'une branche (réponse d'un orchestrateur enfant) ─────
      if (msg.redclaw_diverge_return) {
        const { divergeId, lensName, response } = msg.redclaw_diverge_return;
        const session = node._sessions.get(divergeId);
        if (!session) { done(); return; }

        session.responses.push({ lens: lensName, response });
        session.pending.delete(lensName);

        if (session.pending.size === 0 || node.strategy === "first_wins") {
          // Toutes les réponses reçues (ou première gagnante)
          clearTimeout(session.timer);
          node._sessions.delete(divergeId);
          session.resolve(session.responses);
        }
        done(); return;
      }

      // ── Nouveau signal à traiter en mode divergent ────────────────────
      if (!node.lenses.length) {
        node.warn("[Diverge] Aucun lens configuré");
        done(); return;
      }

      const divergeId = randomUUID().slice(0, 8);
      node.status({ fill: "blue", shape: "dot",
        text: `⟳ ${node.lenses.length} perspectives…` });

      try {
        const responses = await new Promise((resolve, reject) => {
          const pending = new Set(node.lenses.map(l => l.name));
          const timer   = setTimeout(() => {
            node._sessions.delete(divergeId);
            // Timeout partiel : retourne ce qu'on a reçu
            const session = node._sessions.get(divergeId);
            if (session?.responses?.length) {
              resolve(session.responses);
            } else {
              reject(new Error(`Timeout diverge (${node.timeout}ms) — 0 réponse reçue`));
            }
          }, node.timeout);

          node._sessions.set(divergeId, {
            pending, responses: [], resolve, reject, timer,
          });

          // Envoie sur chaque sortie en parallèle
          const out = new Array(node._total).fill(null);
          node.lenses.forEach((lens, i) => {
            out[i] = {
              ...msg,
              payload:       msg.payload,
              redclaw_lens:  { id: lens.name, name: lens.name, prompt: lens.prompt || "", index: i },
              redclaw_diverge_id: divergeId,
              // Enrichit le contexte avec le cadrage cognitif
              redclaw_frame_prompt: lens.prompt || "",
            };
          });
          send(out);
        });

        node.status({ fill: "green", shape: "dot",
          text: `✓ ${responses.length}/${node.lenses.length} réponses` });

        // Agrège toutes les perspectives sur la sortie ⚡
        const out = new Array(node._total).fill(null);
        out[node._retour] = {
          ...msg,
          payload: responses,
          redclaw_diverge: {
            divergeId,
            strategy:   node.strategy,
            lensCount:  node.lenses.length,
            responses,
            // Synthèse texte pour le LLM de convergence
            summary: responses.map(r =>
              `[${r.lens}] ${String(r.response).slice(0, 200)}`
            ).join("\n\n"),
          },
        };
        send(out);

      } catch (e) {
        node.status({ fill: "red", shape: "ring", text: e.message.slice(0, 40) });
        node.error(`[Diverge] ${e.message}`, msg);
      }

      done();
    });

    node.on("close", function () {
      for (const [, s] of node._sessions) {
        clearTimeout(s.timer);
        s.reject(new Error("Nœud fermé"));
      }
      node._sessions.clear();
      node.status({});
    });
  }

  RED.nodes.registerType("redclaw-diverge", RedclawDivergeNode);
};
