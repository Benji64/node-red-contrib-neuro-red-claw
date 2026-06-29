/**
 * RedClaw v1.7 — Goal Store
 *
 * Objectifs persistants du système cognitif.
 * Un objectif est une intention mesurable avec un état de progression.
 *
 * Structure d'un objectif :
 * {
 *   id          : "energie_conso_mensuelle"
 *   skill       : "energie"          // skill propriétaire
 *   name        : "Réduire conso sous 200 kWh/mois"
 *   description : "..."
 *   priority    : "critical"|"high"|"medium"|"low"
 *   metric      : "kwh_monthly"      // nom de la métrique suivie
 *   target      : 200                // valeur cible
 *   current     : 187                // valeur courante
 *   unit        : "kWh"
 *   direction   : "minimize"|"maximize"|"reach"
 *   status      : "active"|"achieved"|"paused"|"failed"
 *   progress    : 0.93               // 0..1
 *   createdAt   : ISO
 *   updatedAt   : ISO
 *   deadline    : ISO | null
 *   context     : "Guide pour le LLM"
 * }
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");

class GoalStore {
  constructor(storageDir) {
    this.storageDir = storageDir
      || path.join(os.homedir(), ".node-red", "redclaw-goals");
    this._goals     = new Map(); // id → goal
    this._goalFile  = path.join(this.storageDir, "goals.json");
    this._ensureDir();
    this._load();
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  upsert(goal) {
    const existing = this._goals.get(goal.id);
    const now      = new Date().toISOString();
    const merged   = {
      priority:  "medium",
      direction: "minimize",
      status:    "active",
      progress:  0,
      current:   null,
      unit:      "",
      deadline:  null,
      context:   "",
      ...existing,
      ...goal,
      id:        goal.id,
      updatedAt: now,
      createdAt: existing?.createdAt || now,
    };
    merged.progress = _calcProgress(merged);
    merged.status   = _calcStatus(merged);
    this._goals.set(merged.id, merged);
    this._persist();
    return merged;
  }

  /**
   * Met à jour la valeur courante d'un objectif
   */
  update(id, currentValue) {
    const goal = this._goals.get(id);
    if (!goal) return null;
    goal.current   = currentValue;
    goal.updatedAt = new Date().toISOString();
    goal.progress  = _calcProgress(goal);
    goal.status    = _calcStatus(goal);
    this._persist();
    return goal;
  }

  get(id)    { return this._goals.get(id) || null; }
  delete(id) { this._goals.delete(id); this._persist(); }

  // ─── Requêtes ─────────────────────────────────────────────────────────────

  all()   { return [...this._goals.values()]; }

  bySkill(skillName) {
    return this.all().filter(g => g.skill === skillName);
  }

  active() {
    return this.all().filter(g => g.status === "active");
  }

  critical() {
    return this.all().filter(g => g.priority === "critical" && g.status === "active");
  }

  /**
   * Résumé compact pour injection dans le system prompt LLM
   */
  buildGoalContext(skillName = null) {
    const goals = skillName ? this.bySkill(skillName) : this.active();
    if (!goals.length) return "";

    const byPriority = { critical: [], high: [], medium: [], low: [] };
    goals.forEach(g => (byPriority[g.priority] || byPriority.medium).push(g));

    const lines = [];
    for (const [p, gs] of Object.entries(byPriority)) {
      if (!gs.length) continue;
      gs.forEach(g => {
        const pct  = Math.round(g.progress * 100);
        const bar  = _progressBar(g.progress);
        const curr = g.current !== null ? ` (actuel: ${g.current}${g.unit})` : "";
        lines.push(`[${p.toUpperCase()}] ${g.name} ${bar} ${pct}%${curr}`);
      });
    }
    return `Objectifs actifs :\n${lines.join("\n")}`;
  }

  // ─── Persistance ──────────────────────────────────────────────────────────

  _persist() {
    try {
      fs.writeFileSync(
        this._goalFile,
        JSON.stringify([...this._goals.values()], null, 2),
        "utf8"
      );
    } catch (_) {}
  }

  _load() {
    try {
      if (!fs.existsSync(this._goalFile)) return;
      const goals = JSON.parse(fs.readFileSync(this._goalFile, "utf8"));
      goals.forEach(g => this._goals.set(g.id, g));
    } catch (_) {}
  }

  _ensureDir() {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _calcProgress(goal) {
  if (goal.current === null || goal.target === null) return goal.progress || 0;
  const { current, target, direction } = goal;
  if (direction === "maximize") return Math.min(1, current / target);
  if (direction === "minimize") return Math.min(1, target / Math.max(current, 0.001));
  if (direction === "reach")    return current >= target ? 1 : current / target;
  return 0;
}

function _calcStatus(goal) {
  if (goal.status === "paused" || goal.status === "failed") return goal.status;
  if (goal.progress >= 1) return "achieved";
  if (goal.deadline && new Date() > new Date(goal.deadline)) return "failed";
  return "active";
}

function _progressBar(p) {
  const filled = Math.round(p * 10);
  return "[" + "█".repeat(filled) + "░".repeat(10 - filled) + "]";
}

const instance = new GoalStore();
module.exports = instance;
module.exports.GoalStore = GoalStore;
