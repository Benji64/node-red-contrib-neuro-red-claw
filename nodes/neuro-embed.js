/**
 * neuro-red-claw — Embed
 *
 * Nœud opérationnel d'embedding sémantique.
 * Utilise un embed-config pour vectoriser et un VectorStore interne pour persister.
 *
 * ─── Modes ───────────────────────────────────────────────────────────────────
 *  "store"  : vectorise msg.payload et stocke dans la base
 *  "search" : vectorise msg.payload et cherche les K plus similaires
 *  "both"   : stocke ET recherche (mémoire conversationnelle complète)
 *  "auto"   : lit msg.embed_action pour choisir ("store"|"search")
 *
 * ─── Câblage type ─────────────────────────────────────────────────────────────
 *
 *  [redclaw-skill] ──► [neuro-embed: store] ──► [redclaw-orchestrator]
 *                            (stocke la question)
 *
 *  [redclaw-orchestrator] ──► [neuro-embed: search] ──1──► [redclaw-orchestrator]
 *                              (injecte contexte)              (avec mémoire sémantique)
 *
 * ─── Réduction du contexte ──────────────────────────────────────────────────
 *
 *  Sans embedding : sliding window 20 messages = ~4000 chars
 *  Avec embedding : top-5 similaires = ~800 chars pertinents
 *  Gain : -80% tokens, +pertinence sémantique
 */

const VectorStore = require("../lib/vector-store");
const path        = require("path");
const os          = require("os");

module.exports = function (RED) {
  function NeuroEmbedNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.mode         = config.mode        || "both";
    node.storeName    = (config.storeName  || "default").trim();
    node.k            = parseInt(config.k, 10)         || 5;
    node.threshold    = parseFloat(config.threshold)   || 0.5;
    node.maxChars     = parseInt(config.maxChars, 10)  || 2000;
    node.metaFields   = (config.metaFields || "sessionId,skill,role").split(",").map(s=>s.trim());

    // Récupère le nœud de config embedding
    node.embedConfig  = config.embedConfig
      ? RED.nodes.getNode(config.embedConfig)
      : null;

    // Store vecteurs persistant
    const storeDir = config.storeDir?.trim()
      || path.join(RED.settings.userDir || os.homedir()+"/.node-red", "redclaw-vectors");

    node.store = new VectorStore({
      name:       node.storeName,
      storageDir: storeDir,
      maxDocs:    parseInt(config.maxDocs, 10) || 10000,
    });

    node.status({
      fill: node.embedConfig ? "green" : "yellow",
      shape: "dot",
      text: `${node.storeName} · ${node.store.size()} docs`,
    });

    node.on("input", async function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      if (!node.embedConfig) {
        node.error("[neuro-embed] Aucun embed-config sélectionné", msg);
        done(); return;
      }

      const text   = typeof msg.payload === "string"
        ? msg.payload.trim()
        : JSON.stringify(msg.payload);
      if (!text) { done(); return; }

      const action = msg.embed_action || node.mode;

      node.status({ fill:"blue", shape:"ring",
        text:`${action} · "${text.slice(0,30)}…"` });

      try {
        // ── Embed le texte ──────────────────────────────────────────────
        const vector = await node.embedConfig.embed(text);
        if (!vector?.length) throw new Error("Vecteur vide — modèle disponible ?");

        // ── STORE ───────────────────────────────────────────────────────
        if (action === "store" || action === "both") {
          const meta = { ts: Date.now() };
          node.metaFields.forEach(f => { if (msg[f]) meta[f] = msg[f]; });
          if (msg.redclaw?.skill?.name) meta.skill = msg.redclaw.skill.name;
          if (msg.redclaw?.userMessage) meta.type  = "user";

          node.store.add(text, vector, meta);
          node.status({ fill:"green", shape:"dot",
            text:`✓ stocké · ${node.store.size()} docs` });
        }

        // ── SEARCH ──────────────────────────────────────────────────────
        if (action === "search" || action === "both") {
          // Filtre optionnel par sessionId
          const filter = msg.sessionId
            ? doc => !doc.metadata.sessionId || doc.metadata.sessionId === msg.sessionId
            : null;

          const ctx = node.store.buildContext(vector, node.maxChars, {
            k: node.k, threshold: node.threshold, filter,
          });

          node.status({ fill:"green", shape:"dot",
            text:`✓ ${ctx.retrieved} docs · ${ctx.chars} chars` });

          if (ctx.retrieved === 0) {
            // Output 2 : rien trouvé
            send([null, { ...msg, payload: text,
              embed_context: "", embed_results: [], embed_vector: vector }]);
            done(); return;
          }

          // Output 1 : contexte sémantique prêt pour l'orchestrateur
          send([{
            ...msg,
            payload:        text,              // message original préservé
            embed_context:  ctx.context,       // contexte compact à injecter
            embed_results:  ctx.results,       // résultats détaillés
            embed_vector:   vector,            // vecteur (pour debug / pipeline)
            embed_chars:    ctx.chars,
            embed_retrieved: ctx.retrieved,
          }, null]);

        } else {
          // Mode store seul → output 1 pass-through
          send([{ ...msg, embed_vector: vector }, null]);
        }

      } catch (e) {
        node.status({ fill:"red", shape:"ring", text: e.message.slice(0,40) });
        node.error(`[neuro-embed] ${e.message}`, msg);
        send([null, { ...msg, embed_error: e.message }]);
      }

      done();
    });

    node.on("close", () => { node.store.destroy(); node.status({}); });
  }

  // ── Endpoint REST ──────────────────────────────────────────────────────────
  RED.httpAdmin.get("/redclaw/vectors/:store",
    RED.auth.needsPermission("flows.read"),
    (req, res) => {
      try {
        const storeDir = path.join(
          RED.settings.userDir || os.homedir()+"/.node-red", "redclaw-vectors"
        );
        const store = new VectorStore({ name: req.params.store, storageDir: storeDir });
        res.json(store.stats());
      } catch (e) { res.status(500).json({ error: e.message }); }
    }
  );

  RED.nodes.registerType("neuro-embed", NeuroEmbedNode);
};
