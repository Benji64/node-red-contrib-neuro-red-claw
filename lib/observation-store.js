/**
 * RedClaw v1.8 — Observation Store
 *
 * Agrège les signaux entrants (capteurs, événements, états)
 * en un "monde perçu" cohérent pour le raisonnement.
 *
 * Chaque observation est indexée par :
 *   - source  : nom du capteur / skill / événement
 *   - key     : clé de la valeur (ex: "temperature", "presence")
 *   - value   : valeur courante
 *   - ts      : timestamp
 *   - ttl     : durée de validité (ms) — passée ce délai, l'obs. expire
 */

class ObservationStore {
  constructor() {
    this._obs = new Map(); // "source:key" → { source, key, value, ts, ttl, unit, label }
  }

  /**
   * Enregistre ou met à jour une observation
   */
  record(source, key, value, options = {}) {
    const id  = `${source}:${key}`;
    const obs = {
      source,
      key,
      value,
      ts:    Date.now(),
      ttl:   options.ttl   || 300000, // 5 min par défaut
      unit:  options.unit  || "",
      label: options.label || `${source}.${key}`,
    };
    this._obs.set(id, obs);
    return obs;
  }

  /**
   * Retourne toutes les observations non expirées
   */
  current() {
    const now = Date.now();
    const result = [];
    for (const [id, obs] of this._obs) {
      if (now - obs.ts < obs.ttl) {
        result.push(obs);
      } else {
        this._obs.delete(id); // purge automatique
      }
    }
    return result;
  }

  /**
   * Observations d'une source spécifique
   */
  fromSource(source) {
    return this.current().filter(o => o.source === source);
  }

  /**
   * Construit un résumé textuel compact pour le LLM
   */
  buildPerceptionSummary() {
    const obs = this.current();
    if (!obs.length) return "Aucune observation disponible.";

    // Groupe par source
    const bySource = {};
    obs.forEach(o => {
      if (!bySource[o.source]) bySource[o.source] = [];
      bySource[o.source].push(`${o.key}: ${o.value}${o.unit}`);
    });

    return Object.entries(bySource)
      .map(([src, vals]) => `[${src}] ${vals.join(", ")}`)
      .join("\n");
  }

  /**
   * Détecte les changements significatifs depuis la dernière vérification
   * Retourne les observations dont la valeur a changé de plus de threshold%
   */
  detectChanges(prevSnapshot, threshold = 0.1) {
    const changes = [];
    for (const obs of this.current()) {
      const id   = `${obs.source}:${obs.key}`;
      const prev = prevSnapshot?.[id];
      if (!prev) { changes.push({ ...obs, type: "new" }); continue; }
      if (typeof obs.value === "number" && typeof prev.value === "number") {
        const delta = Math.abs(obs.value - prev.value) / (Math.abs(prev.value) || 1);
        if (delta > threshold) changes.push({ ...obs, type: "changed", prev: prev.value, delta });
      } else if (obs.value !== prev.value) {
        changes.push({ ...obs, type: "changed", prev: prev.value });
      }
    }
    return changes;
  }

  /**
   * Snapshot de l'état actuel (pour comparaison future)
   */
  snapshot() {
    const snap = {};
    for (const obs of this.current()) {
      snap[`${obs.source}:${obs.key}`] = obs;
    }
    return snap;
  }

  size()  { return this._obs.size; }
  clear() { this._obs.clear(); }
}

const instance = new ObservationStore();
module.exports = instance;
module.exports.ObservationStore = ObservationStore;
