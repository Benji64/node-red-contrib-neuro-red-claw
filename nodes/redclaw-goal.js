/**
 * RedClaw v1.7 — Goal
 *
 * Suit un objectif mesurable dans le flow Node-RED.
 * Reçoit des valeurs numériques, calcule la progression, injecte
 * le contexte objectif dans les orchestrateurs connectés.
 *
 * ─── Entrée ──────────────────────────────────────────────────────────────────
 *  msg.payload = valeur numérique (ex: 160 pour 160 kWh)
 *  msg.redclaw_goal = { action: "get"|"pause"|"reset" } → commandes
 *
 * ─── Sorties ─────────────────────────────────────────────────────────────────
 *  Output 1 → état enrichi (msg.redclaw_goal = état complet)
 *             Câbler vers l'entrée du skill / orchestrateur
 *             L'orchestrateur reçoit le contexte objectif automatiquement
 *  Output 2 → événement "atteint" (une seule fois, quand progress >= 1)
 *             Câbler vers une notification, un autre skill, un dashboard
 *
 * ─── Câblage type ────────────────────────────────────────────────────────────
 *  [Capteur Enedis] ──► [redclaw-goal: conso] ──1──► [skill: energie]
 *                                               └──2──► [notification]
 *
 *  [MQTT voix] ──► [skill: energie] ──► [Orchestrateur Energie]
 *  (l'orchestrateur lit msg.redclaw_goal si présent dans son contexte)
 */

const goalStore = require("../lib/goal-store");
const { parseFiniteNumber } = require("../lib/numeric");
const { types } = require("node:util");

module.exports = function (RED) {
  function RedclawGoalNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    function readConfigValue(key) {
      if (!config || typeof config !== "object" || types.isProxy(config)) {
        node.warn("[Goal] Configuration must be a plain object; using defaults");
        return { present: false, valid: false };
      }
      const descriptor = Object.getOwnPropertyDescriptor(config, key);
      if (!descriptor) return { present: false, valid: true };
      if (!Object.hasOwn(descriptor, "value")) {
        node.warn(`[Goal] Configuration "${key}" must be a data property; using its default`);
        return { present: true, valid: false };
      }
      return { present: true, valid: true, value: descriptor.value };
    }

    function configuredString(key, fallback = "") {
      const configured = readConfigValue(key);
      if (!configured.valid) return fallback;
      if (!configured.present || configured.value === undefined || configured.value === null) {
        return fallback;
      }
      if (typeof configured.value !== "string") {
        node.warn(`[Goal] Configuration "${key}" must be a string; using its default`);
        return fallback;
      }
      return configured.value.trim();
    }

    const configuredGoalId = configuredString("goalId");
    node.goalId = configuredGoalId || `goal_${node.id.slice(0, 8)}`;
    node.skillName = configuredString("skillName");
    node.goalName = configuredString("goalName");
    node.metricName = configuredString("metric");
    node.unit = configuredString("unit");
    node.goalCtx = configuredString("goalCtx");

    const priorities = new Set(["critical", "high", "medium", "low"]);
    const configuredPriority = readConfigValue("priority");
    if (configuredPriority.valid && configuredPriority.present &&
        configuredPriority.value !== undefined && !priorities.has(configuredPriority.value)) {
      node.warn('[Goal] Configuration "priority" is invalid; using "medium"');
    }
    node.priority = configuredPriority.valid && priorities.has(configuredPriority.value)
      ? configuredPriority.value
      : "medium";

    const configuredTarget = readConfigValue("target");
    node.target = configuredTarget.valid && configuredTarget.present
      ? parseFiniteNumber(configuredTarget.value) ?? 0
      : 0;
    if (configuredTarget.valid && configuredTarget.present &&
        configuredTarget.value !== undefined && parseFiniteNumber(configuredTarget.value) === null) {
      node.warn('[Goal] Configuration "target" must be a finite number; using 0');
    }

    const directions = new Set(["minimize", "maximize", "reach"]);
    const configuredDirection = readConfigValue("direction");
    if (configuredDirection.valid && configuredDirection.present &&
        configuredDirection.value !== undefined && !directions.has(configuredDirection.value)) {
      node.warn('[Goal] Configuration "direction" is invalid; using "minimize"');
    }
    node.direction = configuredDirection.valid && directions.has(configuredDirection.value)
      ? configuredDirection.value
      : "minimize";

    const configuredDeadline = readConfigValue("deadline");
    node.deadline = null;
    if (configuredDeadline.valid && configuredDeadline.present &&
        configuredDeadline.value !== undefined && configuredDeadline.value !== null &&
        configuredDeadline.value !== "") {
      if (typeof configuredDeadline.value === "string" &&
          Number.isFinite(Date.parse(configuredDeadline.value))) {
        node.deadline = configuredDeadline.value;
      } else {
        node.warn('[Goal] Configuration "deadline" must be a valid date; ignoring it');
      }
    }

    // Crée ou restaure l'objectif au démarrage
    const goal = goalStore.upsert({
      id:        node.goalId,
      skill:     node.skillName,
      name:      node.goalName,
      priority:  node.priority,
      metric:    node.metricName,
      target:    node.target,
      unit:      node.unit,
      direction: node.direction,
      deadline:  node.deadline || null,
      context:   node.goalCtx,
    });

    _display(goal);

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      // ── Commandes de contrôle ────────────────────────────────────────
      if (msg.redclaw_goal?.action) {
        const g = goalStore.get(node.goalId);
        switch (msg.redclaw_goal.action) {
          case "get":
            send([{ ...msg, payload: g?.current, redclaw_goal: g }, null]);
            break;
          case "pause": {
            // v2.8 — FIX : passe par upsert() plutôt que de muter g en
            // place + appeler _persist() (méthode privée du store). Même
            // discipline que reset() juste en-dessous.
            const paused = goalStore.upsert({ ...g, status: "paused" });
            node.status({ fill:"grey", shape:"ring", text:"Pause" });
            send([{ ...msg, payload: paused?.current, redclaw_goal: paused }, null]);
            break;
          }
          case "reset":
            const reset = goalStore.upsert({ ...g, current: null, status:"active", progress:0 });
            _display(reset);
            send([{ ...msg, payload: null, redclaw_goal: reset }, null]);
            break;
        }
        done(); return;
      }

      // ── Mise à jour de la métrique ───────────────────────────────────
      const value = parseFiniteNumber(msg.payload);

      if (value === null) {
        node.warn(`[Goal] Valeur non numérique : "${msg.payload}"`);
        done(); return;
      }

      const prevStatus = goalStore.get(node.goalId)?.status;
      const updated    = goalStore.update(node.goalId, value);
      _display(updated);

      // Output 1 : transmet le msg enrichi avec l'état de l'objectif
      // msg.goal_context n'existe QUE si ce nœud est câblé sur le chemin —
      // c'est le fil qui autorise l'influence, pas une recherche par nom en arrière-plan
      const goal_context = goalStore.buildGoalContext(node.skillName);
      send([{
        ...msg,
        payload:      value,          // valeur originale préservée
        redclaw_goal: updated,        // état structuré de cet objectif
        goal_context,                 // résumé texte — lu passivement par l'orchestrateur si câblé
      }, null]);

      // Output 2 : événement unique "atteint" (passage actif → achieved)
      if (updated.status === "achieved" && prevStatus !== "achieved") {
        send([null, {
          ...msg,
          payload:             updated,
          redclaw_goal:        updated,
          redclaw_goal_achieved: true,
        }]);
      }

      done();
    });

    function _display(goal) {
      if (!goal) return;
      const pct    = Math.round((goal.progress || 0) * 100);
      const colors = { achieved:"green", failed:"red", paused:"grey", active:"blue" };
      node.status({
        fill:  colors[goal.status] || "blue",
        shape: goal.status === "achieved" ? "dot" : "ring",
        text:  `${goal.name.slice(0,22)} ${pct}%${goal.current !== null ? ` (${goal.current}${goal.unit})` : ""}`,
      });
    }

    node.on("close", () => node.status({}));
  }

  RED.nodes.registerType("redclaw-goal", RedclawGoalNode);
};
