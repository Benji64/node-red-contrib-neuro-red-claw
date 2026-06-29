/**
 * neuro-red-claw — Vector Store
 *
 * Base de données vectorielle légère sans dépendance externe.
 * Persistance JSON sur disque. Recherche par similarité cosinus.
 *
 * Conçue pour des centaines à quelques milliers de documents.
 * Pour des millions de docs → utiliser Chroma ou Qdrant.
 *
 * Structure d'un document :
 * {
 *   id        : identifiant unique
 *   text      : texte original
 *   vector    : float[]
 *   metadata  : { skill, sessionId, ts, role, type, ... }
 *   ts        : timestamp
 * }
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");

class VectorStore {
  constructor(options = {}) {
    this.name       = options.name       || "default";
    this.storageDir = options.storageDir || path.join(os.homedir(), ".node-red", "redclaw-vectors");
    this.maxDocs    = options.maxDocs    || 10000;
    this._docs      = [];   // [{ id, text, vector, metadata, ts }]
    this._file      = path.join(this.storageDir, `${this.name}.json`);
    this._dirty     = false;
    this._saveTimer = null;

    this._ensureDir();
    this._load();
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  /**
   * Ajoute ou met à jour un document
   */
  upsert(id, text, vector, metadata = {}) {
    const existing = this._docs.findIndex(d => d.id === id);
    const doc = { id, text, vector, metadata, ts: Date.now() };

    if (existing >= 0) {
      this._docs[existing] = doc;
    } else {
      this._docs.push(doc);
      // Purge si trop grand (supprime les plus anciens)
      if (this._docs.length > this.maxDocs) {
        this._docs.sort((a, b) => a.ts - b.ts);
        this._docs = this._docs.slice(-this.maxDocs);
      }
    }
    this._scheduleSave();
    return doc;
  }

  /**
   * Ajoute un document avec ID auto
   */
  add(text, vector, metadata = {}) {
    const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`;
    return this.upsert(id, text, vector, metadata);
  }

  delete(id) {
    const before = this._docs.length;
    this._docs = this._docs.filter(d => d.id !== id);
    if (this._docs.length < before) this._scheduleSave();
  }

  get(id) { return this._docs.find(d => d.id === id) || null; }

  // ─── Recherche sémantique ─────────────────────────────────────────────────

  /**
   * Recherche les K documents les plus similaires
   * @param {number[]} queryVector  vecteur de la question
   * @param {object}   options
   *   k          : nombre de résultats (défaut: 5)
   *   threshold  : similarité minimale 0..1 (défaut: 0.5)
   *   filter     : fonction (doc) => bool pour filtrer avant recherche
   * @returns {{ doc, score }[]} triés par score décroissant
   */
  search(queryVector, options = {}) {
    const k         = options.k         || 5;
    const threshold = options.threshold || 0.5;
    const filter    = options.filter    || null;

    let candidates = this._docs;
    if (filter) candidates = candidates.filter(filter);

    const scored = candidates
      .map(doc => ({
        doc,
        score: _cosineSimilarity(queryVector, doc.vector),
      }))
      .filter(r => r.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    return scored;
  }

  /**
   * Recherche + retourne seulement les textes (pour injection dans le contexte LLM)
   */
  searchTexts(queryVector, options = {}) {
    return this.search(queryVector, options).map(r => ({
      text:     r.doc.text,
      score:    Math.round(r.score * 100) / 100,
      metadata: r.doc.metadata,
    }));
  }

  /**
   * Construit un contexte compact pour injection dans le LLM
   * Retourne seulement les textes les plus pertinents, sous budget token
   */
  buildContext(queryVector, maxChars = 2000, options = {}) {
    const results = this.searchTexts(queryVector, { k: 20, threshold: 0.5, ...options });
    const parts   = [];
    let totalChars = 0;

    for (const r of results) {
      if (totalChars + r.text.length > maxChars) break;
      parts.push(r.text);
      totalChars += r.text.length;
    }

    return {
      context:   parts.join("\n---\n"),
      retrieved: parts.length,
      chars:     totalChars,
      results,
    };
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  size()  { return this._docs.length; }
  stats() {
    return {
      name:    this.name,
      docs:    this._docs.length,
      maxDocs: this.maxDocs,
      file:    this._file,
      dims:    this._docs[0]?.vector?.length || 0,
    };
  }

  clear() { this._docs = []; this._scheduleSave(); }

  // ─── Persistance ──────────────────────────────────────────────────────────

  _scheduleSave() {
    this._dirty = true;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    // Sauvegarde différée 2s après le dernier changement
    this._saveTimer = setTimeout(() => this._save(), 2000);
  }

  _save() {
    try {
      fs.writeFileSync(this._file, JSON.stringify(this._docs), "utf8");
      this._dirty = false;
    } catch (_) {}
  }

  _load() {
    try {
      if (!fs.existsSync(this._file)) return;
      this._docs = JSON.parse(fs.readFileSync(this._file, "utf8"));
    } catch (_) { this._docs = []; }
  }

  _ensureDir() {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  destroy() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    if (this._dirty) this._save();
  }
}

// ─── Cosinus ──────────────────────────────────────────────────────────────────

function _cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

module.exports = VectorStore;
