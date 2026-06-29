/**
 * neuro-red-claw — Embedding Client
 *
 * Appelle l'API d'embedding d'Ollama (ou compatible OpenAI).
 * Transforme du texte en vecteurs pour la recherche sémantique.
 *
 * Modèles recommandés (Ollama) :
 *   mxbai-embed-large  → 1024 dims, excellent, ~670M
 *   nomic-embed-text   → 768 dims, léger, ~274M
 *   all-minilm         → 384 dims, ultra-léger pour Pi
 *
 * Usage :
 *   const client = new EmbeddingClient({ baseUrl: "http://localhost:11434", model: "mxbai-embed-large" });
 *   const vector = await client.embed("Allume la lumière du salon");
 *   const vectors = await client.embedBatch(["texte 1", "texte 2"]);
 */

const fetch = require("node-fetch");

class EmbeddingClient {
  constructor(config = {}) {
    this.baseUrl = (config.baseUrl || "http://localhost:11434").replace(/\/$/, "");
    this.model   = config.model   || "mxbai-embed-large";
    this.timeout = parseInt(config.timeout, 10) || 15000;
    this.type    = config.type    || "ollama"; // "ollama" | "openai"
    this.apiKey  = config.apiKey  || "";
  }

  /**
   * Embed un seul texte → vecteur
   * @param {string} text
   * @returns {number[]} vecteur de floats
   */
  async embed(text) {
    const clean = String(text || "").trim().slice(0, 4096); // limite raisonnable
    if (!clean) return [];

    try {
      if (this.type === "openai") {
        return this._embedOpenAI(clean);
      }
      return this._embedOllama(clean);
    } catch (e) {
      throw new Error(`[EmbeddingClient] embed échoué : ${e.message}`);
    }
  }

  /**
   * Embed un tableau de textes en parallèle
   * @param {string[]} texts
   * @returns {number[][]}
   */
  async embedBatch(texts) {
    // Traitement par lots de 8 pour éviter de surcharger le serveur
    const results = [];
    for (let i = 0; i < texts.length; i += 8) {
      const batch = texts.slice(i, i + 8);
      const vecs  = await Promise.all(batch.map(t => this.embed(t)));
      results.push(...vecs);
    }
    return results;
  }

  // ─── Backends ─────────────────────────────────────────────────────────────

  async _embedOllama(text) {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ model: this.model, input: text }),
      signal:  AbortSignal.timeout(this.timeout),
    });
    if (!res.ok) throw new Error(`Ollama embed HTTP ${res.status}`);
    const data = await res.json();

    // Ollama retourne embeddings[0] ou embedding selon la version
    const vec = data.embeddings?.[0] || data.embedding;
    if (!vec?.length) throw new Error("Ollama embed : vecteur vide");
    return vec;
  }

  async _embedOpenAI(text) {
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body:    JSON.stringify({ model: this.model, input: text }),
      signal:  AbortSignal.timeout(this.timeout),
    });
    if (!res.ok) throw new Error(`OpenAI embed HTTP ${res.status}`);
    const data = await res.json();
    return data.data?.[0]?.embedding || [];
  }

  /**
   * Vérifie que le modèle d'embedding est disponible
   */
  async healthCheck() {
    try {
      const vec = await this.embed("test");
      return { ok: true, dims: vec.length, model: this.model };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

module.exports = EmbeddingClient;
