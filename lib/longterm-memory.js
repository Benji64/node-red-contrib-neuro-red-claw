/**
 * neuro-red-claw — Long-term Memory
 *
 * Mémoire d'habitudes et de patterns qui survit AU-DELÀ du sliding window.
 * Différent de conversation-memory (court terme, roulant) :
 * ici on garde des FAITS DISTILLÉS, renforcés par répétition.
 *
 * Exemples :
 *   "Paulette allume le salon vers 18h30 en hiver" (habit, confidence 0.9, 23 occurrences)
 *   "La conso énergie augmente le weekend" (pattern, confidence 0.7, 8 occurrences)
 *
 * Alimentée typiquement par redclaw-reflect (patterns détectés) ou
 * manuellement via le nœud neuro-longterm.
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const TYPES = { HABIT: "habit", PATTERN: "pattern", FACT: "fact" };

class LongtermMemory {
  constructor(storageDir) {
    this.storageDir = storageDir || path.join(os.homedir(), ".node-red", "redclaw-longterm");
    this._memories   = new Map(); // id → { id, skill, type, content, confidence, occurrences, firstSeen, lastSeen }
    this._file       = path.join(this.storageDir, "memories.json");
    this._ensureDir();
    this._load();
  }

  /**
   * Enregistre ou renforce un souvenir long terme.
   * Si un contenu similaire existe déjà pour ce skill → renforce au lieu de dupliquer.
   */
  record(skillName, type, content, options = {}) {
    const norm = _normalize(content);
    const existing = [...this._memories.values()].find(
      m => m.skill === skillName && _normalize(m.content) === norm
    );

    if (existing) return this.reinforce(existing.id);

    const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`;
    const mem = {
      id, skill: skillName, type: type || TYPES.FACT, content,
      confidence:  options.confidence ?? 0.3, // confiance initiale basse
      occurrences: 1,
      firstSeen:   new Date().toISOString(),
      lastSeen:    new Date().toISOString(),
      source:      options.source || "manual",
    };
    this._memories.set(id, mem);
    this._scheduleSave();
    // Copie indépendante — jamais la référence stockée en interne, pour
    // que reinforce() ultérieur ne mute pas silencieusement une valeur
    // qu'un appelant garde déjà (même bug/même fix que goal-store.js).
    return { ...mem };
  }

  /**
   * Renforce un souvenir existant (observé à nouveau)
   */
  reinforce(id) {
    const existing = this._memories.get(id);
    if (!existing) return null;
    // v2.10 — FIX : remplace l'entrée par une copie fraîche au lieu de
    // muter `existing` en place. Deux appels successifs à reinforce()
    // retournaient auparavant la MÊME référence mutée deux fois.
    const updated = {
      ...existing,
      occurrences: existing.occurrences + 1,
      lastSeen:    new Date().toISOString(),
    };
    updated.confidence = Math.min(0.99, updated.occurrences / (updated.occurrences + 5));
    this._memories.set(id, updated);
    this._scheduleSave();
    return { ...updated };
  }

  delete(id) { this._memories.delete(id); this._scheduleSave(); }
  get(id)    { const m = this._memories.get(id); return m ? { ...m } : null; }

  bySkill(skillName) {
    return [...this._memories.values()].filter(m => m.skill === skillName);
  }

  all() { return [...this._memories.values()]; }

  /**
   * Top souvenirs pertinents pour un skill, triés par confiance × récence
   * Applique une légère décroissance si pas revu depuis longtemps
   */
  buildContext(skillName, limit = 5) {
    const now = Date.now();
    const items = this.bySkill(skillName)
      .map(m => {
        const daysSince = (now - new Date(m.lastSeen).getTime()) / 86400000;
        const decay = Math.max(0.3, 1 - daysSince / 90); // décroît sur 90 jours, plancher 0.3
        return { ...m, _score: m.confidence * decay };
      })
      .sort((a, b) => b._score - a._score)
      .slice(0, limit);

    if (!items.length) return "";

    const lines = items.map(m => {
      const pct = Math.round(m.confidence * 100);
      const icon = { habit: "🔁", pattern: "📊", fact: "📌" }[m.type] || "•";
      return `${icon} ${m.content} (${pct}% confiance, vu ${m.occurrences}×)`;
    });

    return "Mémoire long terme :\n" + lines.join("\n");
  }

  destroy() { if (this._saveTimer) clearTimeout(this._saveTimer); this._save(); }

  // ─── Persistance ──────────────────────────────────────────────────────────

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._save(), 2000);
  }
  _save() {
    try { fs.writeFileSync(this._file, JSON.stringify([...this._memories.values()]), "utf8"); }
    catch (_) {}
  }
  _load() {
    try {
      if (!fs.existsSync(this._file)) return;
      const arr = JSON.parse(fs.readFileSync(this._file, "utf8"));
      arr.forEach(m => this._memories.set(m.id, m));
    } catch (_) {}
  }
  _ensureDir() {
    if (!fs.existsSync(this.storageDir)) fs.mkdirSync(this.storageDir, { recursive: true });
  }
}

function _normalize(s) {
  return String(s || "").toLowerCase().trim().replace(/\s+/g, " ");
}

const instance = new LongtermMemory();
module.exports = instance;
module.exports.LongtermMemory = LongtermMemory;
module.exports.TYPES = TYPES;
