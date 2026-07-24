/**
 * neuro-red-claw — Skill Trust
 *
 * Mémoire sémantique sur la FIABILITÉ des skills/tools.
 * Différent de ticket-store (logs bruts) : ici on garde le savoir distillé
 * "ce tool est fiable" / "cette action échoue souvent".
 *
 * Se nourrit automatiquement de chaque tool_call déjà tracé par
 * l'orchestrateur — zéro câblage supplémentaire requis pour l'enregistrement.
 *
 * Formule du trust score : lissage de Laplace (évite les 0%/100% sur peu d'échantillons)
 *   trustScore = (success + 1) / (success + failure + 2)
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");

class SkillTrust {
  constructor(storageDir) {
    this.storageDir = storageDir || path.join(os.homedir(), ".node-red", "redclaw-trust");
    this._trust = new Map(); // "skill::tool" → { success, failure, totalDuration, lastFailureAt, lastFailureReason }
    this._file  = path.join(this.storageDir, "trust.json");
    this._ensureDir();
    this._load();
  }

  // ─── Enregistrement (appelé automatiquement par l'orchestrateur) ───────────

  record(skillName, toolName, success, durationMs = 0, errorReason = null) {
    const key = `${skillName || "?"}::${toolName || "?"}`;
    const t = this._trust.get(key) || {
      skill: skillName, tool: toolName,
      success: 0, failure: 0, totalDuration: 0,
      lastFailureAt: null, lastFailureReason: null,
      firstSeen: new Date().toISOString(),
    };

    if (success) t.success++;
    else {
      t.failure++;
      t.lastFailureAt     = new Date().toISOString();
      t.lastFailureReason = errorReason || "inconnu";
    }
    t.totalDuration += durationMs;
    t.lastSeen = new Date().toISOString();

    this._trust.set(key, t);
    this._scheduleSave();
    return this._computeTrust(t);
  }

  // ─── Lecture ────────────────────────────────────────────────────────────────

  getTrust(skillName, toolName) {
    const t = this._trust.get(`${skillName}::${toolName}`);
    return t ? this._computeTrust(t) : null;
  }

  getSkillTrust(skillName) {
    return [...this._trust.values()]
      .filter(t => t.skill === skillName)
      .map(t => this._computeTrust(t));
  }

  all() {
    return [...this._trust.values()].map(t => this._computeTrust(t));
  }

  /**
   * Tools dont le score de confiance est sous le seuil
   */
  lowTrust(threshold = 0.7) {
    return this.all().filter(t => t.trustScore < threshold && t.totalCalls >= 3);
  }

  /**
   * Résumé textuel pour injection dans le system prompt LLM
   */
  buildTrustContext(skillName) {
    const items = skillName ? this.getSkillTrust(skillName) : this.all();
    if (!items.length) return "";

    const lines = items
      .filter(t => t.totalCalls >= 2) // évite le bruit sur 1 seul appel
      .sort((a, b) => a.trustScore - b.trustScore)
      .map(t => {
        const pct = Math.round(t.trustScore * 100);
        const tag = t.trustScore < 0.6 ? "⚠️ PEU FIABLE" : t.trustScore > 0.9 ? "✅" : "";
        const fail = t.lastFailureReason ? ` (dernier échec: ${t.lastFailureReason})` : "";
        return `${tag} ${t.tool} : ${pct}% fiabilité sur ${t.totalCalls} appels${fail}`;
      });

    return lines.length ? "Fiabilité des tools :\n" + lines.join("\n") : "";
  }

  reset(skillName, toolName) {
    this._trust.delete(`${skillName}::${toolName}`);
    this._scheduleSave();
  }

  // ─── Calcul ───────────────────────────────────────────────────────────────

  _computeTrust(t) {
    const totalCalls = t.success + t.failure;
    const trustScore = (t.success + 1) / (totalCalls + 2); // Laplace smoothing
    return {
      skill: t.skill, tool: t.tool,
      success: t.success, failure: t.failure, totalCalls,
      trustScore: Math.round(trustScore * 1000) / 1000,
      avgDuration: totalCalls ? Math.round(t.totalDuration / totalCalls) : 0,
      lastFailureAt: t.lastFailureAt,
      lastFailureReason: t.lastFailureReason,
      lastSeen: t.lastSeen,
    };
  }

  // ─── Persistance ──────────────────────────────────────────────────────────

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._save(), 2000);
  }
  _save() {
    try {
      fs.writeFileSync(this._file, JSON.stringify([...this._trust.values()]), "utf8");
    } catch (_) {}
  }
  _load() {
    try {
      if (!fs.existsSync(this._file)) return;
      const arr = JSON.parse(fs.readFileSync(this._file, "utf8"));
      arr.forEach(t => this._trust.set(`${t.skill}::${t.tool}`, t));
    } catch (_) {}
  }
  _ensureDir() {
    if (!fs.existsSync(this.storageDir)) fs.mkdirSync(this.storageDir, { recursive: true });
  }
  destroy() { if (this._saveTimer) clearTimeout(this._saveTimer); this._save(); }
}

const instance = new SkillTrust();
module.exports = instance;
module.exports.SkillTrust = SkillTrust;
