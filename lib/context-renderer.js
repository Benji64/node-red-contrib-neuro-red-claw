/**
 * RedClaw v1.5 — Context Renderer
 *
 * Compresse le contexte envoyé au LLM pour rester dans le budget token.
 * Estimation : 1 token ≈ 4 caractères (approximation conservative).
 *
 * Priorités de compression (ordre croissant de sacrifice) :
 *   1. Tronque les exemples longs dans le contexte du skill
 *   2. Réduit l'historique aux N derniers échanges
 *   3. Résume l'historique ancien en une ligne compacte
 *   4. Coupe le contexte skill à l'essentiel (nom + tools)
 */

const CHARS_PER_TOKEN = 4;

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
   * @param {object} skill      { name, context, tools, mcpServer }
   * @param {string} history    historique résumé depuis conversation-memory
   * @param {object} options    { debugMode }
   * @returns {string}          system prompt prêt à envoyer au LLM
   */
  renderSystem(skill, history = "", options = {}) {
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
    const fixedChars  = instructions.length;
    const remaining   = this.maxChars - fixedChars - 100; // 100 chars de marge

    // Construit le bloc skill
    const skillHeader = `Skill actif : ${skill.name}\nTools : ${toolsList.join(", ")}`;
    let   skillContext = skill.context || "";
    let   historyBlock = history || "";

    // Tronque le contexte skill si trop long (garde les 2 premiers paragraphes)
    const contextBudget = Math.floor(remaining * 0.5);
    if (skillContext.length > contextBudget) {
      const paras = skillContext.split("\n\n");
      skillContext = paras.slice(0, 2).join("\n\n");
      if (skillContext.length > contextBudget) {
        skillContext = skillContext.slice(0, contextBudget) + "…";
      }
    }

    // Tronque l'historique si trop long
    const historyBudget = remaining - skillContext.length - skillHeader.length - 50;
    if (historyBlock.length > historyBudget && historyBudget > 0) {
      // Garde seulement la fin de l'historique (plus récent = plus pertinent)
      historyBlock = "…" + historyBlock.slice(-historyBudget);
    }

    const parts = [instructions, skillHeader];
    if (skillContext) parts.push(skillContext);
    if (historyBlock) parts.push("", "Historique récent :", historyBlock);

    const result = parts.join("\n");

    if (options.debugMode) {
      const tokens = this.estimate(result);
      return { prompt: result, tokens, compressed: tokens < this.estimate(
        instructions + skillHeader + (skill.context||"") + history
      )};
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

module.exports = ContextRenderer;
