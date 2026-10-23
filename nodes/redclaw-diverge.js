/**
 * RedClaw v2.1 — Diverge
 *
 * Pensée divergente : envoie le même signal sur N sorties simultanément,
 * chacune avec un "cadrage cognitif" différent (lens).
 * Attend les N réponses puis les agrège sur la sortie ⚡.
 *
 * Même pattern que mcp-router mais pour les perspectives cognitives.
 *
 * ─── Câblage ─────────────────────────────────────────────────────────────────
 *  [Signal] ──► [redclaw-diverge]
 *    ├─ 1 ──► [skill: angle A] ──► [Orch A] Output2 ──► [diverge] entrée
 *    ├─ 2 ──► [skill: angle B] ──► [Orch B] Output2 ──► [diverge] entrée
 *    ├─ 3 ──► [skill: angle C] ──► [Orch C] Output2 ──► [diverge] entrée
 *    └─ ⚡ ──► [synthèse / décision]
 *
 * ─── Sorties ─────────────────────────────────────────────────────────────────
 *  1..N  → une par "lens" (cadrage cognitif) configuré
 *  N+1   → ⚡ agrégation de toutes les réponses
 *
 * ─── msg enrichi sur chaque sortie ──────────────────────────────────────────
 *  msg.redclaw_lens  = { id, name, prompt, index }
 *  msg.redclaw_diverge_id = identifiant de cette session divergente
 */

const { randomUUID } = require("crypto");
const { parseFiniteInteger, timerDelayOrDefault } = require("../lib/numeric");
const { types } = require("node:util");
const { runTreeReasoning } = require("../lib/tree-reasoner");

const TREE_RULE_TYPES = new Set(["contains", "not_contains", "min_length", "max_length"]);

function parseTreeRules(raw, version) {
  if (typeof version !== "string" || !version.trim() || version.length > 100) {
    throw new Error("treeRulesVersion is required");
  }
  if (typeof raw !== "string") throw new Error("treeRules must be JSON text");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 50) {
    throw new Error("rules must be a non-empty array of at most 50 entries");
  }
  const seen = new Set();
  const rules = parsed.map((rule, index) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      throw new Error(`rule ${index} must be an object`);
    }
    const allowed = new Set(["id", "type", "value", "weight", "required", "opposes"]);
    if (Object.keys(rule).some(key => !allowed.has(key))) {
      throw new Error(`rule ${index} contains an unsupported field`);
    }
    if (typeof rule.id !== "string" || !rule.id.trim() ||
        rule.id.length > 100 || seen.has(rule.id)) {
      throw new Error(`rule ${index} id must be unique and non-empty`);
    }
    seen.add(rule.id);
    if (!TREE_RULE_TYPES.has(rule.type)) throw new Error(`rule ${index} type is not supported`);
    const textRule = rule.type === "contains" || rule.type === "not_contains";
    if (textRule ? (typeof rule.value !== "string" || !rule.value || rule.value.length > 1000)
      : (!Number.isInteger(rule.value) || rule.value < 0 || rule.value > 100000)) {
      throw new Error(`rule ${index} value is invalid`);
    }
    const weight = rule.weight === undefined ? 1 : rule.weight;
    if (!Number.isFinite(weight) || weight <= 0 || weight > 1000000) {
      throw new Error(`rule ${index} weight is invalid`);
    }
    if (rule.required !== undefined && typeof rule.required !== "boolean") {
      throw new Error(`rule ${index} required must be a boolean`);
    }
    if (rule.opposes !== undefined &&
        (typeof rule.opposes !== "string" || !rule.opposes.trim() || rule.opposes.length > 100)) {
      throw new Error(`rule ${index} opposes must be a non-empty rule ID`);
    }
    return {
      id: rule.id,
      type: rule.type,
      value: rule.value,
      weight,
      required: rule.required === true,
      ...(rule.opposes === undefined ? {} : { opposes: rule.opposes }),
    };
  });
  const rulesById = new Map(rules.map(rule => [rule.id, rule]));
  for (const rule of rules) {
    if (rule.opposes === undefined) continue;
    const opposite = rulesById.get(rule.opposes);
    if (!opposite || opposite.id === rule.id || opposite.opposes !== rule.id) {
      throw new Error(`rule "${rule.id}" opposes must reference a reciprocal rule`);
    }
  }
  return { version: version.trim(), rules };
}

function applyTreeRule(rule, text) {
  switch (rule.type) {
    case "contains": return text.toLowerCase().includes(rule.value.toLowerCase());
    case "not_contains": return !text.toLowerCase().includes(rule.value.toLowerCase());
    case "min_length": return text.length >= rule.value;
    default: return text.length <= rule.value;
  }
}

module.exports = function (RED) {
  function RedclawDivergeNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    function readConfigValue(key) {
      if (!config || typeof config !== "object" || types.isProxy(config)) {
        node.warn("[Diverge] Configuration must be a plain object; using defaults");
        return { present: false, valid: false };
      }
      const descriptor = Object.getOwnPropertyDescriptor(config, key);
      if (!descriptor) return { present: false, valid: true };
      if (!Object.hasOwn(descriptor, "value")) {
        node.warn(`[Diverge] Configuration "${key}" must be a data property; using its default`);
        return { present: true, valid: false };
      }
      return { present: true, valid: true, value: descriptor.value };
    }

    const lensNames = new Set();
    node.lenses = [];
    const configuredLenses = readConfigValue("lenses");
    if (configuredLenses.valid && configuredLenses.present &&
        configuredLenses.value !== undefined && configuredLenses.value !== null) {
      if (!Array.isArray(configuredLenses.value) || types.isProxy(configuredLenses.value)) {
        node.warn('[Diverge] Configuration "lenses" must be an array; no perspectives will be activated');
      } else {
        for (let index = 0; index < configuredLenses.value.length; index++) {
          const lensProperty = Object.getOwnPropertyDescriptor(configuredLenses.value, String(index));
          const lens = lensProperty && Object.hasOwn(lensProperty, "value")
            ? lensProperty.value
            : null;
          if (!lensProperty || !Object.hasOwn(lensProperty, "value") ||
              !lens || typeof lens !== "object" || Array.isArray(lens) || types.isProxy(lens)) {
            node.warn(`[Diverge] Perspective invalide à l'index ${index}; entrée ignorée`);
            continue;
          }
          const nameProperty = Object.getOwnPropertyDescriptor(lens, "name");
          if (!nameProperty || !Object.hasOwn(nameProperty, "value") ||
              typeof nameProperty.value !== "string" || !nameProperty.value.trim()) {
            node.warn(`[Diverge] Nom de perspective invalide à l'index ${index}; entrée ignorée`);
            continue;
          }
          const name = nameProperty.value;
          if (lensNames.has(name)) {
            node.warn(`[Diverge] Perspective dupliquée "${name}", ignorée`);
            continue;
          }
          let prompt = "";
          const promptProperty = Object.getOwnPropertyDescriptor(lens, "prompt");
          if (promptProperty && !Object.hasOwn(promptProperty, "value")) {
            node.warn(`[Diverge] Le prompt de "${name}" doit être une propriété de données; prompt ignoré`);
          } else if (promptProperty && typeof promptProperty.value === "string") {
            prompt = promptProperty.value;
          } else if (promptProperty && promptProperty.value !== undefined && promptProperty.value !== null) {
            node.warn(`[Diverge] Le prompt de "${name}" doit être une chaîne; prompt ignoré`);
          }
          lensNames.add(name);
          node.lenses.push({ name, prompt });
        }
      }
    }
    const configuredTimeout = readConfigValue("timeout");
    node.timeout = timerDelayOrDefault(
      configuredTimeout.valid ? configuredTimeout.value : undefined,
      30000,
    );
    if (configuredTimeout.valid && configuredTimeout.present &&
        configuredTimeout.value !== "") {
      const parsedTimeout = parseFiniteInteger(configuredTimeout.value);
      if (parsedTimeout === null || parsedTimeout <= 0 || parsedTimeout > 2147483647) {
        node.warn('[Diverge] Configuration "timeout" must be a positive timer delay; using 30000');
      }
    }
    const configuredStrategy = readConfigValue("strategy");
    const strategies = new Set(["wait_all", "first_wins", "majority"]);
    if (configuredStrategy.valid && configuredStrategy.present &&
        typeof configuredStrategy.value !== "string") {
      node.warn('[Diverge] Configuration "strategy" must be a string; using "wait_all"');
    }
    const strategy = configuredStrategy.valid && typeof configuredStrategy.value === "string"
      ? configuredStrategy.value.trim()
      : "wait_all";
    if (strategy && !strategies.has(strategy)) {
      node.warn(`[Diverge] Stratégie "${strategy}" non reconnue; utilisation de "wait_all"`);
    }
    node.strategy = strategies.has(strategy) ? strategy : "wait_all";
    const configuredTreeAdapter = readConfigValue("treeAdapter");
    if (configuredTreeAdapter.valid && configuredTreeAdapter.present &&
        typeof configuredTreeAdapter.value !== "boolean") {
      node.warn('[Diverge] Configuration "treeAdapter" must be a boolean; disabled');
    }
    node.treeAdapter = configuredTreeAdapter.valid &&
      typeof configuredTreeAdapter.value === "boolean"
      ? configuredTreeAdapter.value
      : false;

    // Explicit, user-supplied deterministic rules; absent rules keep presence-only scope.
    node.treeRules = null;
    const configuredRules = readConfigValue("treeRules");
    const configuredRulesVersion = readConfigValue("treeRulesVersion");
    if (node.treeAdapter && configuredRules.valid && configuredRules.present &&
        !(typeof configuredRules.value === "string" && !configuredRules.value.trim())) {
      try {
        node.treeRules = parseTreeRules(configuredRules.value, configuredRulesVersion.valid
          ? configuredRulesVersion.value : undefined);
      } catch (e) {
        node.warn(`[Diverge] Configuration "treeRules" rejected (${e.message}); presence-only evaluation used`);
      }
    }

    /*
     * Keep duplicate names out of the index: a return identifies a branch by
     * name, so routing duplicate names would make the response ambiguous.
     */
    node._idx = new Map();
    node.lenses.forEach((lens, index) => {
      if (lensNames.has(lens.name)) {
        node._idx.set(lens.name, index);
      }
    });
    node._total  = node.lenses.length + 1;
    node._retour = node.lenses.length;

    // Sessions divergentes en attente : divergeId → { pending Set, responses [], resolve, reject, timer }
    node._sessions = new Map();

    node.status({ fill: "green", shape: "dot",
      text: node.lenses.map(l => l.name).join(" · ") || "Aucun lens" });

    node.on("input", async function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      // ── Retour d'une branche (réponse d'un orchestrateur enfant) ─────
      if (Object.hasOwn(msg, "redclaw_diverge_return")) {
        const branchReturn = msg.redclaw_diverge_return;
        if (!branchReturn || typeof branchReturn !== "object" || Array.isArray(branchReturn) ||
            typeof branchReturn.divergeId !== "string" || !branchReturn.divergeId ||
            typeof branchReturn.lensName !== "string" || !branchReturn.lensName ||
            !Object.hasOwn(branchReturn, "response")) {
          node.warn("[Diverge] Retour de branche invalide, ignoré");
          done();
          return;
        }
        const { divergeId, lensName, response } = branchReturn;
        const session = node._sessions.get(divergeId);
        if (!session || !session.pending.has(lensName)) { done(); return; }

        session.responses.push({ lens: lensName, response });
        session.pending.delete(lensName);

        // v2.16 — FIX : majority était documenté mais AUCUNE branche ne
        // l'implémentait — le nœud se comportait comme wait_all. Résout dès
        // que strictement plus de la moitié des lenses ont répondu.
        const isMajority = node.strategy === "majority" &&
          session.responses.length > node.lenses.length / 2;

        if (session.pending.size === 0 || node.strategy === "first_wins" || isMajority) {
          clearTimeout(session.timer);
          node._sessions.delete(divergeId);
          session.resolve(session.responses);
        }
        done(); return;
      }

      // ── Nouveau signal à traiter en mode divergent ────────────────────
      if (!node.lenses.length) {
        node.warn("[Diverge] Aucun lens configuré");
        done(); return;
      }

      const divergeId = randomUUID();
      node.status({ fill: "blue", shape: "dot",
        text: `⟳ ${node.lenses.length} perspectives…` });

      try {
        const responses = await new Promise((resolve, reject) => {
          const pending = new Set(node.lenses.map(l => l.name));
          const timer   = setTimeout(() => {
            // v2.16 — FIX : la session était supprimée AVANT d'être relue,
            // donc session valait toujours undefined ici, peu importe le
            // nombre de réponses déjà reçues — le timeout rejetait TOUJOURS
            // avec 0 réponse reçue, même avec des réponses partielles en
            // main. Lire d'abord, supprimer ensuite.
            const session = node._sessions.get(divergeId);
            node._sessions.delete(divergeId);
            if (session?.responses?.length) {
              resolve(session.responses);
            } else {
              reject(new Error(`Timeout diverge (${node.timeout}ms) — 0 réponse reçue`));
            }
          }, node.timeout);

          node._sessions.set(divergeId, {
            pending, responses: [], resolve, reject, timer,
          });

          // Envoie sur chaque sortie en parallèle
          const out = new Array(node._total).fill(null);
          node.lenses.forEach((lens, i) => {
            out[i] = {
              ...msg,
              payload:       msg.payload,
              redclaw_lens:  { id: lens.name, name: lens.name, prompt: lens.prompt || "", index: i },
              redclaw_diverge_id: divergeId,
              // Enrichit le contexte avec le cadrage cognitif
              redclaw_frame_prompt: lens.prompt || "",
            };
          });
          send(out);
        });

        node.status({ fill: "green", shape: "dot",
          text: `✓ ${responses.length}/${node.lenses.length} réponses` });

        // Agrège toutes les perspectives sur la sortie ⚡
        const out = new Array(node._total).fill(null);
        const cognitiveTree = node.treeAdapter
          ? await _buildCognitiveTree(responses, divergeId)
          : undefined;
        out[node._retour] = {
          ...msg,
          payload: responses,
          redclaw_diverge: {
            divergeId,
            strategy:   node.strategy,
            lensCount:  node.lenses.length,
            responses,
            // Synthèse texte pour le LLM de convergence
            summary: responses.map(r =>
              `[${r.lens}] ${String(r.response).slice(0, 200)}`
            ).join("\n\n"),
            ...(cognitiveTree ? { tree: cognitiveTree } : {}),
          },
        };
        send(out);

      } catch (e) {
        node.status({ fill: "red", shape: "ring", text: e.message.slice(0, 40) });
        node.error(`[Diverge] ${e.message}`, msg);
      }

      done();
    });

    node.on("close", function () {
      for (const [, s] of node._sessions) {
        clearTimeout(s.timer);
        s.reject(new Error("Nœud fermé"));
      }
      node._sessions.clear();
      node.status({});
    });

    async function _buildCognitiveTree(responses, divergeId) {
      const candidates = [];
      const unmappedResponses = [];
      const evaluatedOutcomes = new Map();
      const confrontationCoverage = { comparedPairs: 0, omittedPairs: 0 };
      for (const response of responses) {
        if (typeof response.response !== "string" || !response.response.trim()) {
          unmappedResponses.push({
            lens: response.lens,
            reason: "response_not_non_empty_text",
          });
          continue;
        }
        const statement = response.response.trim().slice(0, 10000);
        candidates.push({
          statement,
          provenance: {
            source: `redclaw-diverge:${response.lens}`,
            recordedAt: new Date().toISOString(),
          },
          evidence: [{
            source: `redclaw-diverge:${response.lens}`,
            content: statement,
            limitations: [
              "Imported branch response; semantic quality was not evaluated.",
            ],
          }],
        });
      }

      const result = await runTreeReasoning({
        root: {
          id: divergeId,
          branchId: divergeId,
          parentId: null,
          childIds: [],
          provenance: {
            source: "redclaw-diverge:tree-adapter",
            recordedAt: new Date().toISOString(),
          },
        },
        criteria: node.treeRules
          ? node.treeRules.rules.map(({ id, weight, required }) => ({ id, weight, required }))
          : [{
            id: "response_received",
            weight: 1,
            required: true,
          }],
        budgets: {
          maxDepth: 1,
          maxBranches: 1000,
          maxNodes: 1001,
          maxCalls: 1001,
          maxTokens: 1,
          maxCost: 0.001,
          timeoutMs: 5000,
          callTimeoutMs: 1000,
        },
        generate: async () => ({ candidates }),
        evaluate: async ({ criteria, hypothesis }) => {
          if (!node.treeRules) {
            return {
              evaluatorVersion: "redclaw-diverge-response-presence-v1",
              justification: "Only response receipt is assessed; semantic quality is not evaluated.",
              results: criteria.map(criterion => ({
                criterion: criterion.id,
                outcome: "pass",
                detail: "A non-empty branch response was received.",
              })),
            };
          }
          const text = String(hypothesis && hypothesis.statement || "");
          const results = node.treeRules.rules.map(rule => ({
            criterion: rule.id,
            outcome: applyTreeRule(rule, text) ? "pass" : "fail",
            detail: `Rule ${rule.type} ${rule.value === undefined ? "" : JSON.stringify(rule.value)}`.trim(),
          }));
          evaluatedOutcomes.set(hypothesis.id, new Map(
            results.map(result => [result.criterion, result.outcome])
          ));
          return {
            evaluatorVersion: node.treeRules.version,
            justification: "Operator-configured deterministic text rules; they do not establish truth or safety.",
            results,
          };
        },
        ...(node.treeRules ? {
          confront: async ({ hypotheses }) => {
            const agreements = [];
            const disagreements = [];
            const contradictions = [];
            const dominantHypotheses = [];
            const underSupportedHypotheses = hypotheses
              .filter(hypothesis => hypothesis.status === "uncertain")
              .map(hypothesis => hypothesis.id);
            const maxPairs = 1000;
            const pairCount = hypotheses.length * (hypotheses.length - 1) / 2;
            let visitedPairs = 0;
            for (let left = 0; left < hypotheses.length; left++) {
              for (let right = left + 1; right < hypotheses.length; right++) {
                if (visitedPairs >= maxPairs) {
                  confrontationCoverage.omittedPairs += pairCount - visitedPairs;
                  return { agreements, disagreements };
                }
                visitedPairs++;
                const leftOutcomes = evaluatedOutcomes.get(hypotheses[left].id);
                const rightOutcomes = evaluatedOutcomes.get(hypotheses[right].id);
                if (!leftOutcomes || !rightOutcomes) {
                  confrontationCoverage.omittedPairs++;
                  continue;
                }
                const agrees = node.treeRules.rules.every(rule =>
                  leftOutcomes.get(rule.id) === rightOutcomes.get(rule.id)
                );
                const pair = {
                  leftId: hypotheses[left].id,
                  rightId: hypotheses[right].id,
                };
                (agrees ? agreements : disagreements).push(pair);
                const hasConfiguredContradiction = node.treeRules.rules.some(rule =>
                  rule.opposes !== undefined && (
                    (leftOutcomes.get(rule.id) === "pass" &&
                      rightOutcomes.get(rule.opposes) === "pass") ||
                    (rightOutcomes.get(rule.id) === "pass" &&
                      leftOutcomes.get(rule.opposes) === "pass")
                  )
                );
                if (hasConfiguredContradiction) contradictions.push(pair);
                confrontationCoverage.comparedPairs++;
              }
            }
            const supported = hypotheses.filter(hypothesis =>
              hypothesis.status === "supported" && evaluatedOutcomes.has(hypothesis.id)
            );
            const scoreFor = hypothesis => {
              const outcomes = evaluatedOutcomes.get(hypothesis.id);
              const totalWeight = node.treeRules.rules.reduce((sum, rule) => sum + rule.weight, 0);
              const passedWeight = node.treeRules.rules.reduce((sum, rule) =>
                sum + (outcomes.get(rule.id) === "pass" ? rule.weight : 0), 0);
              return passedWeight / totalWeight;
            };
            const ranked = supported.map(hypothesis => ({
              id: hypothesis.id,
              score: scoreFor(hypothesis),
            })).sort((left, right) => right.score - left.score);
            if (ranked.length > 0 &&
                (ranked.length === 1 || ranked[0].score > ranked[1].score)) {
              dominantHypotheses.push(ranked[0].id);
            }
            return {
              agreements,
              disagreements,
              contradictions,
              dominantHypotheses,
              underSupportedHypotheses,
            };
          },
        } : {}),
      });

      return {
        status: result.status,
        document: result.document,
        options: result.options,
        confrontation: result.confrontation,
        ...(node.treeRules ? { confrontationCoverage } : {}),
        metrics: result.metrics,
        trace: result.trace,
        traceTruncated: result.traceTruncated,
        uncertainties: result.uncertainties,
        errors: result.errors,
        budgetStops: result.budgetStops,
        disagreements: result.disagreements,
        unmappedResponses,
        evaluationScope: node.treeRules ? "operator_text_rules" : "response_presence_only",
        ...(node.treeRules ? { evaluatorVersion: node.treeRules.version } : {}),
        executionAuthorized: false,
      };
    }
  }

  RED.nodes.registerType("redclaw-diverge", RedclawDivergeNode);
};
