/**
 * neuro-red-claw — Embed Config
 *
 * Nœud de configuration pour les modèles d'embedding.
 * Même principe que llm-config mais pour la vectorisation.
 *
 * Backends supportés :
 *   ollama   → POST /api/embed          (mxbai-embed-large, nomic-embed-text…)
 *   openai   → POST /v1/embeddings      (text-embedding-3-small…)
 *   localai  → POST /v1/embeddings      (compatible OpenAI)
 *   rest     → chemin configurable
 */

const fetch = require("node-fetch");

module.exports = function (RED) {
  function EmbedConfigNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.type    = config.type    || "ollama";
    node.baseUrl = (config.baseUrl || "http://localhost:11434").replace(/\/$/, "");
    node.model   = config.model   || "mxbai-embed-large";
    node.apiKey  = config.apiKey  || "";
    node.timeout = parseInt(config.timeout, 10) || 15000;
    node.dims    = parseInt(config.dims, 10)    || 0; // 0 = auto-détecté

    node.label = () => `${node.type} · ${node.model}`;

    /**
     * Embed un texte → vecteur
     */
    node.embed = async function (text) {
      const clean = String(text || "").trim().slice(0, 8192);
      if (!clean) return [];

      switch (node.type) {
        case "ollama":  return _embedOllama(clean);
        case "openai":
        case "localai": return _embedOpenAI(clean);
        case "rest":    return _embedRest(clean);
        default:        throw new Error(`Type embedding inconnu : ${node.type}`);
      }
    };

    /**
     * Embed un tableau de textes
     */
    node.embedBatch = async function (texts) {
      const results = [];
      for (let i = 0; i < texts.length; i += 8) {
        const batch = texts.slice(i, i + 8);
        const vecs  = await Promise.all(batch.map(t => node.embed(t)));
        results.push(...vecs);
      }
      return results;
    };

    /**
     * Health check
     */
    node.healthCheck = async function () {
      try {
        const vec = await node.embed("test neuro-red-claw");
        return { ok: true, dims: vec.length, model: node.model, type: node.type };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    };

    // ─── Backends ──────────────────────────────────────────────────────────

    async function _embedOllama(text) {
      const res = await fetch(`${node.baseUrl}/api/embed`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ model: node.model, input: text }),
        signal:  AbortSignal.timeout(node.timeout),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Ollama embed HTTP ${res.status}: ${err.slice(0,100)}`);
      }
      const data = await res.json();
      const vec  = data.embeddings?.[0] || data.embedding;
      if (!vec?.length) throw new Error("Vecteur vide — modèle embedding chargé ?");
      if (!node.dims) node.dims = vec.length;
      return vec;
    }

    async function _embedOpenAI(text) {
      const headers = { "Content-Type": "application/json" };
      if (node.apiKey) headers["Authorization"] = `Bearer ${node.apiKey}`;
      const res = await fetch(`${node.baseUrl}/v1/embeddings`, {
        method: "POST",
        headers,
        body:   JSON.stringify({ model: node.model, input: text }),
        signal: AbortSignal.timeout(node.timeout),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Embed HTTP ${res.status}: ${err.slice(0,100)}`);
      }
      const data = await res.json();
      const vec  = data.data?.[0]?.embedding;
      if (!vec?.length) throw new Error("Vecteur vide");
      if (!node.dims) node.dims = vec.length;
      return vec;
    }

    async function _embedRest(text) {
      const path = config.restPath || "/embed";
      const res  = await fetch(`${node.baseUrl}${path}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ model: node.model, input: text, text }),
        signal:  AbortSignal.timeout(node.timeout),
      });
      if (!res.ok) throw new Error(`REST embed HTTP ${res.status}`);
      const data = await res.json();
      // Cherche le vecteur dans plusieurs chemins courants
      const vec  = data.embedding || data.embeddings?.[0] ||
                   data.data?.[0]?.embedding || data.vector;
      if (!vec?.length) throw new Error("Vecteur introuvable dans la réponse REST");
      if (!node.dims) node.dims = vec.length;
      return vec;
    }
  }

  RED.nodes.registerType("embed-config", EmbedConfigNode);
};
