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
const { types }   = require("node:util");
const { parseFiniteInteger, parseFiniteNumber } = require("../lib/numeric");

module.exports = function (RED) {
  function NeuroEmbedNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    function readConfigValue(key) {
      if (!config || typeof config !== "object" || types.isProxy(config)) {
        node.warn("[neuro-embed] Configuration must be a plain object; using defaults");
        return undefined;
      }
      const descriptor = Object.getOwnPropertyDescriptor(config, key);
      if (!descriptor) return undefined;
      if (!Object.hasOwn(descriptor, "value")) {
        node.warn(`[neuro-embed] Configuration "${key}" must be a data property; using its default`);
        return undefined;
      }
      return descriptor.value;
    }
    function readConfigString(key, fallback) {
      const value = readConfigValue(key);
      if (value === undefined) return fallback;
      if (typeof value !== "string") {
        node.warn(`[neuro-embed] Configuration "${key}" must be a string; using its default`);
        return fallback;
      }
      return value;
    }
    function readConfigInteger(key, fallback, isValid, requirement) {
      const value = readConfigValue(key);
      const number = parseFiniteInteger(value);
      if ((value === undefined || value === "") && fallback !== null) return fallback;
      if (number !== null && isValid(number)) return number;
      if (value !== undefined && value !== "") {
        node.warn(`[neuro-embed] Configuration "${key}" must be ${requirement}; using ${fallback}`);
      }
      return fallback;
    }

    const supportedModes = new Set(["store", "search", "both", "auto"]);
    const configuredMode = readConfigString("mode", "both").trim();
    if (configuredMode && !supportedModes.has(configuredMode)) {
      node.warn('[neuro-embed] Configuration "mode" is unsupported; using "both"');
    }
    node.mode = supportedModes.has(configuredMode) ? configuredMode : "both";
    const configuredStoreName = readConfigString("storeName", "default").trim();
    node.storeName = configuredStoreName || "default";
    // Keep reading k for flows saved before the palette field was renamed.
    const configuredTopK = readConfigValue("topK");
    const topKValue = configuredTopK !== undefined ? configuredTopK : readConfigValue("k");
    const topK = parseFiniteInteger(topKValue);
    node.topK = topK !== null && topK >= 1 && topK <= 20 ? topK : 5;
    if (topKValue !== undefined && topKValue !== "" && (topK === null || topK < 1 || topK > 20)) {
      node.warn('[neuro-embed] Configuration "topK" must be an integer between 1 and 20; using 5');
    }
    const thresholdValue = readConfigValue("threshold");
    const threshold = parseFiniteNumber(thresholdValue);
    node.threshold    = threshold !== null && threshold >= 0 && threshold <= 1
      ? threshold
      : 0.5;
    if (thresholdValue !== undefined && thresholdValue !== "" &&
        (threshold === null || threshold < 0 || threshold > 1)) {
      node.warn('[neuro-embed] Configuration "threshold" must be between 0 and 1; using 0.5');
    }
    node.maxChars = readConfigInteger(
      "maxChars", 2000, value => value >= 200, "an integer of at least 200"
    );
    const storeMaxDocs = readConfigInteger(
      "maxDocs", 10000, value => value >= 100, "an integer of at least 100"
    );
    const configuredMetaFields = readConfigString("metaFields", "sessionId,skill,role");
    node.metaFields = (configuredMetaFields || "sessionId,skill,role").split(",").map(s => s.trim());

    // Récupère le nœud de config embedding
    const configuredEmbedId = readConfigString("embedConfig", "");
    node.embedConfig  = configuredEmbedId
      ? RED.nodes.getNode(configuredEmbedId)
      : null;

    // Store vecteurs persistant
    const configuredStoreDir = readConfigString("storeDir", "").trim();
    const storeDir = configuredStoreDir
      || path.join(RED.settings.userDir || os.homedir()+"/.node-red", "redclaw-vectors");

    node.store = new VectorStore({
      name:       node.storeName,
      storageDir: storeDir,
      maxDocs:    storeMaxDocs,
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
            k: node.topK, threshold: node.threshold, filter,
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
