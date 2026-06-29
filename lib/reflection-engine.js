/**
 * RedClaw v2.0 — Reflection Engine
 *
 * Analyse les tickets passés pour détecter des patterns,
 * extraire des insights et proposer des ajustements.
 *
 * C'est la méta-cognition : le système raisonne sur lui-même.
 *
 * Niveaux de réflexion :
 *   1. STATISTIQUE  : compte les succès/échecs, durées, tools utilisés
 *   2. PATTERN      : détecte les récurrences (même erreur, même skill)
 *   3. CAUSAL       : identifie les causes (quel tool échoue, pourquoi)
 *   4. PRESCRIPTIF  : propose des ajustements (skill context, goals, policies)
 */

class ReflectionEngine {
  /**
   * Analyse un ensemble de tickets et produit des insights
   * @param {object[]} tickets  tickets récents depuis ticket-store
   * @returns {object}          rapport de réflexion
   */
  analyze(tickets) {
    if (!tickets?.length) {
      return { insights: [], stats: null, patterns: [], prescriptions: [] };
    }

    const stats        = this._computeStats(tickets);
    const patterns     = this._detectPatterns(tickets, stats);
    const prescriptions = this._prescribe(stats, patterns);

    return {
      analyzedAt:    new Date().toISOString(),
      ticketCount:   tickets.length,
      stats,
      patterns,
      prescriptions,
      insights:      this._buildInsights(stats, patterns, prescriptions),
    };
  }

  /**
   * Construit le prompt de réflexion pour le LLM
   * Le LLM reçoit l'analyse statistique + son contexte et produit des recommandations
   */
  buildReflectionPrompt(tickets, skillName) {
    const report  = this.analyze(tickets);
    const { stats, patterns, prescriptions } = report;

    const parts = [
      `Tu es l'agent "${skillName || "système"}" en train d'analyser tes propres décisions récentes.`,
      "",
      `Sur les ${tickets.length} dernières actions :`,
      `- Taux de succès : ${stats.successRate}%`,
      `- Durée moyenne  : ${stats.avgDuration}ms`,
      `- Tokens moyens  : ${stats.avgTokens}`,
      `- Steps moyens   : ${stats.avgSteps}`,
    ];

    if (stats.topTools?.length) {
      parts.push(`- Tools les plus utilisés : ${stats.topTools.join(", ")}`);
    }
    if (stats.failedTools?.length) {
      parts.push(`- Tools ayant échoué : ${stats.failedTools.join(", ")}`);
    }
    if (patterns.length) {
      parts.push("", "Patterns détectés :");
      patterns.forEach(p => parts.push(`• ${p.description}`));
    }
    if (prescriptions.length) {
      parts.push("", "Suggestions automatiques :");
      prescriptions.forEach(p => parts.push(`• [${p.type}] ${p.suggestion}`));
    }

    parts.push(
      "",
      "En analysant ces informations, identifie :",
      "1. Ce qui fonctionne bien et pourquoi",
      "2. Ce qui échoue et la cause probable",
      "3. Des ajustements concrets à apporter",
      "",
      'Réponds en JSON : {"observations":["..."],"adjustments":[{"type":"skill_context"|"goal"|"policy","target":"...","suggestion":"..."}]}'
    );

    return parts.join("\n");
  }

  // ─── Analyse statistique ──────────────────────────────────────────────────

  _computeStats(tickets) {
    const completed = tickets.filter(t => t.status === "completed");
    const failed    = tickets.filter(t => t.status === "failed");
    const total     = completed.length + failed.length;

    const toolCount = {};
    const failedToolSet = new Set();

    tickets.forEach(t => {
      (t.tool_calls || []).forEach(c => {
        toolCount[c.tool] = (toolCount[c.tool] || 0) + 1;
        if (!c.success) failedToolSet.add(c.tool);
      });
    });

    const topTools = Object.entries(toolCount)
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([t, c]) => `${t}(${c})`);

    return {
      total,
      completed:   completed.length,
      failed:      failed.length,
      successRate: total ? Math.round(completed.length / total * 100) : 0,
      avgDuration: _avg(tickets, "duration_ms"),
      avgTokens:   _avg(tickets, "tokens_in"),
      avgSteps:    _avg(tickets.map(t => ({ v: (t.steps||[]).length })), "v"),
      topTools,
      failedTools: [...failedToolSet],
      bySkill:     _groupBy(tickets, "skill"),
    };
  }

  // ─── Détection de patterns ────────────────────────────────────────────────

  _detectPatterns(tickets, stats) {
    const patterns = [];

    // Pattern 1 : taux d'échec élevé
    if (stats.successRate < 70 && stats.total >= 5) {
      patterns.push({
        type:        "high_failure_rate",
        severity:    "high",
        description: `Taux d'échec élevé (${100 - stats.successRate}% sur ${stats.total} actions)`,
      });
    }

    // Pattern 2 : tools récurrents en échec
    if (stats.failedTools.length > 0) {
      patterns.push({
        type:        "failing_tools",
        severity:    "medium",
        description: `Tools échouant régulièrement : ${stats.failedTools.join(", ")}`,
        tools:       stats.failedTools,
      });
    }

    // Pattern 3 : durée excessive
    if (stats.avgDuration > 10000) {
      patterns.push({
        type:        "slow_responses",
        severity:    "low",
        description: `Réponses lentes en moyenne (${stats.avgDuration}ms)`,
      });
    }

    // Pattern 4 : trop d'étapes (LLM tourne en rond)
    if (stats.avgSteps > 4) {
      patterns.push({
        type:        "excessive_steps",
        severity:    "medium",
        description: `Trop d'étapes LLM en moyenne (${stats.avgSteps} — possible boucle ou contexte insuffisant)`,
      });
    }

    // Pattern 5 : skill dominant
    const skills = Object.entries(stats.bySkill || {});
    if (skills.length > 1) {
      const [topSkill, topCount] = skills.sort((a,b)=>b[1].length-a[1].length)[0];
      const pct = Math.round(topCount.length / stats.total * 100);
      if (pct > 80) {
        patterns.push({
          type:        "skill_concentration",
          severity:    "info",
          description: `${pct}% des actions viennent du skill "${topSkill}"`,
        });
      }
    }

    return patterns;
  }

  // ─── Prescriptions ────────────────────────────────────────────────────────

  _prescribe(stats, patterns) {
    const prescriptions = [];

    patterns.forEach(p => {
      switch (p.type) {
        case "high_failure_rate":
          prescriptions.push({
            type:       "skill_context",
            suggestion: "Enrichir le contexte du skill avec des exemples de cas réussis",
            priority:   "high",
          });
          break;
        case "failing_tools":
          prescriptions.push({
            type:       "mcp_adapter",
            suggestion: `Vérifier la configuration des adapters pour : ${p.tools?.join(", ")}`,
            priority:   "high",
          });
          break;
        case "excessive_steps":
          prescriptions.push({
            type:       "skill_context",
            suggestion: "Simplifier le contexte — le LLM hésite, ajouter des exemples directs",
            priority:   "medium",
          });
          prescriptions.push({
            type:       "orchestrator",
            suggestion: "Réduire maxSteps ou augmenter la précision du system prompt",
            priority:   "medium",
          });
          break;
        case "slow_responses":
          prescriptions.push({
            type:       "llm_config",
            suggestion: "Réduire le budget token ou utiliser un modèle plus rapide",
            priority:   "low",
          });
          break;
      }
    });

    return prescriptions;
  }

  // ─── Insights lisibles ────────────────────────────────────────────────────

  _buildInsights(stats, patterns, prescriptions) {
    const insights = [];
    if (stats.successRate >= 90) insights.push(`✅ Excellent taux de succès (${stats.successRate}%)`);
    if (stats.successRate < 70)  insights.push(`⚠️ Taux de succès faible (${stats.successRate}%) — action requise`);
    patterns.forEach(p => insights.push(`🔍 ${p.description}`));
    prescriptions.forEach(p => insights.push(`💡 [${p.priority}] ${p.suggestion}`));
    return insights;
  }
}

function _avg(arr, key) {
  if (!arr?.length) return 0;
  const vals = arr.map(x => x[key] || 0).filter(v => v > 0);
  return vals.length ? Math.round(vals.reduce((s,v)=>s+v,0)/vals.length) : 0;
}

function _groupBy(arr, key) {
  return arr.reduce((acc, item) => {
    const k = item[key] || "unknown";
    (acc[k] = acc[k] || []).push(item);
    return acc;
  }, {});
}

module.exports = new ReflectionEngine();
module.exports.ReflectionEngine = ReflectionEngine;
