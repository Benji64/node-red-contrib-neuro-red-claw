/**
 * RedClaw v2.0 — Reflect (méta-cognition)
 *
 * L'agent lit ses propres tickets, analyse ses décisions passées,
 * appelle le LLM pour produire des insights, et peut auto-ajuster.
 *
 * ─── Entrée ──────────────────────────────────────────────────────────────────
 *  msg.payload     : déclencheur (inject, timer, événement)
 *  msg.reflect_skill: skill à analyser (optionnel, sinon tous)
 *  msg.reflect_n   : nombre de tickets à analyser (défaut: 50)
 *
 * ─── Sorties ─────────────────────────────────────────────────────────────────
 *  Output 1 : insights JSON + prescriptions → dashboard / skill context
 *  Output 2 : ajustements actionnables → modifier skill, goal, policy
 */

const reflectionEngine = require("../lib/reflection-engine");
const ticketStore      = require("../lib/ticket-store");
const LlmClient        = require("../lib/llm-client");

module.exports = function (RED) {
  function RedclawReflectNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.skillName   = (config.skillName   || "").trim();
    node.analyzeN    = parseInt(config.analyzeN, 10) || 50;
    node.useLlm      = config.useLlm !== false;
    node.autoApply   = config.autoApply === true;
    node.debugMode   = config.debugMode  === true;

    // Config LLM pour la réflexion
    const llmConfigNode = config.llmConfig
      ? RED.nodes.getNode(config.llmConfig) : null;

    node.llm = llmConfigNode
      ? new LlmClient(llmConfigNode)
      : null;

    node.status({ fill: "grey", shape: "ring", text: "En attente de déclencheur" });

    node.on("input", async function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      const skillName = msg.reflect_skill || node.skillName || null;
      const n         = msg.reflect_n     || node.analyzeN;

      node.status({ fill: "blue", shape: "dot", text: "Analyse en cours…" });

      try {
        // ── Récupère les tickets récents ────────────────────────────────
        const tickets = skillName
          ? ticketStore.recent(n, { skill: skillName })
          : ticketStore.recent(n);

        if (!tickets.length) {
          node.status({ fill: "yellow", shape: "ring", text: "Aucun ticket à analyser" });
          send([{ ...msg, payload: { insights: ["Aucun ticket disponible"], tickets: 0 } }, null]);
          done(); return;
        }

        // ── Analyse statistique (sans LLM) ──────────────────────────────
        const report = reflectionEngine.analyze(tickets);

        if (node.debugMode) {
          node.warn(`[Reflect] ${tickets.length} tickets analysés — ${report.insights.length} insights`);
        }

        // ── Enrichit avec le LLM si disponible ──────────────────────────
        let llmInsights = null;
        if (node.useLlm && node.llm) {
          try {
            const prompt   = reflectionEngine.buildReflectionPrompt(tickets, skillName);
            const rawResp  = await node.llm.chat(
              "Tu es un système de méta-cognition. Analyse et réponds uniquement en JSON valide.",
              prompt,
              { temperature: 0.2, maxTokens: 600 }
            );

            // Parse la réponse JSON du LLM
            const clean = rawResp.replace(/```json|```/g, "").trim();
            llmInsights = JSON.parse(clean);
          } catch (e) {
            node.warn(`[Reflect] LLM insight échoué : ${e.message}`);
          }
        }

        // ── Construit le rapport final ───────────────────────────────────
        const finalReport = {
          reflectedAt:   new Date().toISOString(),
          skill:         skillName || "all",
          ticketCount:   tickets.length,
          stats:         report.stats,
          insights:      report.insights,
          patterns:      report.patterns,
          prescriptions: report.prescriptions,
          llmInsights,
        };

        node.status({ fill: "green", shape: "dot",
          text: `✓ ${tickets.length} tickets · ${report.insights.length} insights` });

        // ── Output 1 : rapport complet ───────────────────────────────────
        send([{ ...msg, payload: finalReport, redclaw_reflect: finalReport }, null]);

        // ── Output 2 : ajustements actionnables ──────────────────────────
        const adjustments = [
          ...report.prescriptions,
          ...(llmInsights?.adjustments || []),
        ];

        if (adjustments.length) {
          send([null, {
            ...msg,
            payload:             adjustments,
            redclaw_adjustments: adjustments,
            reflect_skill:       skillName,
          }]);
        }

      } catch (e) {
        node.status({ fill: "red", shape: "ring", text: e.message.slice(0, 40) });
        node.error(`[Reflect] ${e.message}`, msg);
      }

      done();
    });

    node.on("close", () => node.status({}));
  }

  RED.nodes.registerType("redclaw-reflect", RedclawReflectNode);
};
