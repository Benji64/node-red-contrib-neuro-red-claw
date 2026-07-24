/**
 * neuro-red-claw v2.7 — Context Renderer
 *
 * Compresse le contexte envoyé au LLM pour rester dans le budget token.
 * Estimation : 1 token ≈ 4 caractères (approximation conservative).
 *
 * v2.7 — FIX priorité de troncature. Depuis la v1.5, `history` était UN
 * SEUL blob concaténé, tronqué en gardant sa fin ("plus récent = plus
 * pertinent"). Correct quand ce blob = historique conversationnel seul.
 * Mais les v2.2-v2.4 ont ajouté 4 sources supplémentaires (embed, contexte
 * cross-skills, habitudes long terme, fiabilité des tools), toutes
 * concaténées AVANT le vrai historique dans l'ordre d'assemblage de
 * l'orchestrateur. Résultat : sur un budget serré (LLM local à petit
 * contexte — Pi/Radxa, le cas d'usage visé), la troncature "garde la fin"
 * préservait les enrichissements optionnels et coupait l'historique réel
 * en premier — l'inverse de l'intention.
 *
 * Cette version accepte des sources NOMMÉES avec une priorité explicite.
 * Ordre de préservation (le plus protégé en premier) :
 *   1. instructions + skillHeader        (fixe, jamais coupé)
 *   2. contexte du skill                 (déjà tronqué à 2 paragraphes)
 *   3. goals                             (court, définit l'objectif — protégé)
 *   4. constraints                       (court, sécurité/politique — protégé)
 *   5. history                           (conversation récente — tronqué
 *                                          en gardant la FIN si besoin,
 *                                          jamais totalement sacrifié)
 *   6. embed / longterm / trust          (enrichissements optionnels —
 *                                          les premiers sacrifiés
 *                                          entièrement si le budget manque)
 *
 * Rétrocompatible : appeler renderSystem(skill, "un simple historique")
 * avec une string fonctionne toujours identiquement à avant.
 */

const CHARS_PER_TOKEN = 4;
const MIN_MEANINGFUL_CHARS = 40; // sous ce seuil, un fragment tronqué n'apporte rien — on saute le bloc entier

class ContextRenderer {
  /**
   * @param {number} maxTokens  budget total (défaut: 3000 pour laisser de la place à la réponse)
   */
  constructor(maxTokens = 3000) {
    this.maxTokens = maxTokens;
    this.maxChars  = maxTokens * CHARS_PER_TOKEN;
  }

  /**
   * Estime le nombre de tokens d'un texte
   */
  estimate(text) {
    return Math.ceil((text || "").length / CHARS_PER_TOKEN);
  }

  /**
   * Construit le system prompt compressé
   * @param {object} skill    { name, context, tools, mcpServer }
   * @param {string|object} contexts
   *   - string : historique brut seul (comportement legacy inchangé)
   *   - object : { history, goals, constraints, embed, longterm, trust }
   *     chaque champ optionnel, priorité de troncature dans cet ordre
   * @param {object} options  { debugMode }
   * @returns {string} system prompt prêt à envoyer au LLM
   */
  renderSystem(skill, contexts = "", options = {}) {
    const instructions = [
      "Tu es un agent IA. Réponds UNIQUEMENT en JSON valide, sans texte autour.",
      "",
      'Pour appeler un tool : {"action":"tool","tool":"nom","params":{}}',
      'Pour répondre      : {"action":"respond","message":"ta réponse"}',
      "",
    ].join("\n");

    const toolsList = (skill.tools || "")
      .split(",")
      .map(t => t.trim())
      .filter(Boolean);

    // Budget restant après les instructions fixes
    const fixedChars = instructions.length;
    const remaining0  = this.maxChars - fixedChars - 100; // 100 chars de marge

    // Construit le bloc skill (comportement inchangé)
    const skillHeader = `Skill actif : ${skill.name}\nTools : ${toolsList.join(", ")}`;
    let   skillContext = skill.context || "";

    const contextBudget = Math.floor(remaining0 * 0.5);
    if (skillContext.length > contextBudget) {
      const paras = skillContext.split("\n\n");
      skillContext = paras.slice(0, 2).join("\n\n");
      if (skillContext.length > contextBudget) {
        skillContext = skillContext.slice(0, contextBudget) + "…";
      }
    }

    const remaining = remaining0 - skillContext.length - skillHeader.length - 50;

    // Normalise l'entrée : string legacy → traité comme "history" seul
    const src = typeof contexts === "string"
      ? { history: contexts }
      : (contexts || {});

    // Remplissage prioritaire du budget restant, dans l'ordre protégé → sacrifiable
    const rendered = _fillByPriority(remaining, [
      { label: "Objectifs actifs",        text: src.goals,      truncateFrom: "start" },
      { label: "Contraintes",             text: src.constraints, truncateFrom: "start" },
      { label: "Historique récent",       text: src.history,    truncateFrom: "end" }, // garde la fin = le + récent
      { label: "Mémoire sémantique",      text: src.embed,      truncateFrom: "start" },
      { label: "Mémoire long terme",      text: src.longterm,   truncateFrom: "start" },
      { label: "Fiabilité des tools",     text: src.trust,      truncateFrom: "start" },
    ]);

    const parts = [instructions, skillHeader];
    if (skillContext) parts.push(skillContext);
    for (const block of rendered) {
      parts.push("", `${block.label} :`, block.text);
    }

    const result = parts.join("\n");

    if (options.debugMode) {
      const allInputChars = [src.goals, src.constraints, src.history, src.embed, src.longterm, src.trust]
        .filter(Boolean).join("").length;
      return {
        prompt: result,
        tokens: this.estimate(result),
        included: rendered.map(b => b.label),
        dropped:  ["Objectifs actifs","Contraintes","Historique récent","Mémoire sémantique","Mémoire long terme","Fiabilité des tools"]
          .filter(l => !rendered.some(b => b.label === l)),
        compressed: this.estimate(result) < this.estimate(instructions + skillHeader + (skill.context||"") + " ".repeat(allInputChars)),
      };
    }
    return result;
  }

  /**
   * Construit le user prompt depuis l'historique de la boucle courante
   */
  renderUser(loopHistory, userMessage) {
    const lines = [];

    for (const h of loopHistory) {
      switch (h.role) {
        case "user":        lines.push(`Demande: ${h.content}`); break;
        case "tool_call":   lines.push(`[Action: ${h.content}]`); break;
        case "tool_result": lines.push(`[Résultat: ${h.content}]`); break;
        default:            lines.push(h.content);
      }
    }

    return lines.join("\n") || `Demande: ${userMessage}`;
  }
}

/**
 * Remplit un budget de caractères en parcourant des blocs par ordre de
 * priorité décroissante. Le premier bloc qui ne rentre pas entièrement est
 * tronqué pour occuper exactement le budget restant ; tous les blocs
 * suivants (moins prioritaires) sont entièrement sacrifiés — pas de
 * fragments inutiles de quelques mots éparpillés.
 */
function _fillByPriority(budget, blocks) {
  const out = [];
  let remaining = budget;

  for (const { label, text, truncateFrom } of blocks) {
    if (!text) continue;
    if (remaining <= MIN_MEANINGFUL_CHARS) break; // plus de place utile — on arrête, on ne saupoudre pas

    if (text.length <= remaining) {
      out.push({ label, text });
      remaining -= text.length;
      continue;
    }

    // Ne rentre pas entièrement : tronque pour occuper le reste du budget, puis on s'arrête
    const truncated = truncateFrom === "end"
      ? "…" + text.slice(-(remaining - 1))
      : text.slice(0, remaining - 1) + "…";
    out.push({ label, text: truncated });
    remaining = 0;
    break;
  }

  return out;
}

module.exports = ContextRenderer;
