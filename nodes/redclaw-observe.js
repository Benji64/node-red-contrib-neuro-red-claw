/**
 * RedClaw v1.8 — Observe (phase O de ORA)
 *
 * Agrège les signaux entrants en une perception unifiée.
 * Déclenche le cycle ORA quand les conditions sont remplies.
 *
 * ─── Entrées ─────────────────────────────────────────────────────────────────
 *  Toutes les sources se connectent à l'entrée unique :
 *  msg.payload     = valeur du signal
 *  msg.ora_source  = nom de la source (ex: "capteur_temp")
 *  msg.ora_key     = clé de la valeur (ex: "temperature")
 *  msg.ora_unit    = unité optionnelle (ex: "°C")
 *  msg.ora_ttl     = durée de validité ms (défaut: 300000 = 5min)
 *
 * ─── Sorties ─────────────────────────────────────────────────────────────────
 *  Output 1 → Perception complète → [skill] → [Orchestrateur R]
 *             Déclenché selon le mode configuré
 *  Output 2 → Changement détecté (signal brut) → optionnel
 *
 * ─── Modes de déclenchement ─────────────────────────────────────────────────
 *  "always"  : déclenche à chaque signal reçu
 *  "change"  : déclenche seulement si un changement significatif est détecté
 *  "manual"  : ne déclenche que sur msg.ora_trigger = true
 */

const observationStore = require("../lib/observation-store");
const goalStore        = require("../lib/goal-store");
const skillRegistry    = require("../lib/skill-registry");

module.exports = function (RED) {
  function RedclawObserveNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.skillName    = (config.skillName   || "").trim();
    node.triggerMode  = config.triggerMode  || "change";
    node.changeThresh = parseFloat(config.changeThresh) || 0.05; // 5%
    node.defaultTtl   = parseInt(config.defaultTtl, 10) || 300000;
    node.includeGoals = config.includeGoals !== false;
    node.includeSkills= config.includeSkills !== false;

    // Snapshot précédent pour détection des changements
    node._prevSnapshot = {};

    node.status({ fill: "green", shape: "ring",
      text: `Observe · ${observationStore.size()} signal(s)` });

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      // ── Enregistre le signal entrant ─────────────────────────────────
      const source = msg.ora_source || msg.topic || "sensor";
      const key    = msg.ora_key    || "value";
      const value  = msg.payload;
      const ttl    = msg.ora_ttl    || node.defaultTtl;
      const unit   = msg.ora_unit   || "";

      observationStore.record(source, key, value, { ttl, unit, label: `${source}.${key}` });

      node.status({ fill: "blue", shape: "ring",
        text: `${observationStore.size()} signal(s) · [${source}:${key}=${value}${unit}]` });

      // ── Vérifie si on doit déclencher le raisonnement ────────────────
      let shouldTrigger = false;
      let changes = [];

      switch (node.triggerMode) {
        case "always":
          shouldTrigger = true;
          break;

        case "change":
          changes = observationStore.detectChanges(node._prevSnapshot, node.changeThresh);
          shouldTrigger = changes.length > 0;
          break;

        case "manual":
          shouldTrigger = msg.ora_trigger === true;
          break;
      }

      if (!shouldTrigger) { done(); return; }

      // ── Construit la perception unifiée ──────────────────────────────
      node._prevSnapshot = observationStore.snapshot();

      const perception = _buildPerception(msg, changes);

      // Output 2 : changements bruts (optionnel)
      if (changes.length) {
        send([null, { ...msg, payload: changes, ora_changes: changes }]);
      }

      // Output 1 : perception complète → skill → orchestrateur
      send([{
        payload:        perception.summary,   // userMessage pour le skill
        sessionId:      node.skillName || "ora",
        ora_perception: perception,           // contexte complet
        ora_trigger:    true,
      }, null]);

      node.status({ fill: "green", shape: "dot",
        text: `✓ déclenché · ${changes.length || "∞"} changement(s)` });

      done();
    });

    function _buildPerception(msg, changes) {
      const observations  = observationStore.current();
      const perceptionTxt = observationStore.buildPerceptionSummary();
      const goalCtx       = node.includeGoals
        ? goalStore.buildGoalContext(node.skillName)
        : "";
      const skillsCtx     = node.includeSkills
        ? skillRegistry.buildCapabilitiesIndex()
        : "";

      // Message naturel pour le LLM
      const parts = ["État actuel du système :"];
      if (perceptionTxt) parts.push(perceptionTxt);
      if (goalCtx)       parts.push("", goalCtx);
      if (changes.length) {
        parts.push("", "Changements détectés :",
          changes.map(c => `• ${c.label}: ${c.prev ?? "?"} → ${c.value}${c.unit} (${c.type})`).join("\n")
        );
      }
      parts.push("", "Que faut-il faire ?");

      return {
        summary:       parts.join("\n"),
        observations,
        changes,
        goals:         node.includeGoals ? goalStore.active() : [],
        skills:        node.includeSkills ? skillRegistry.all() : [],
        generatedAt:   new Date().toISOString(),
      };
    }

    node.on("close", () => { observationStore.clear(); node.status({}); });
  }

  RED.nodes.registerType("redclaw-observe", RedclawObserveNode);
};
