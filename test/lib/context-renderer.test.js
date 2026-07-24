/**
 * Verrouille le bug corrigé en v2.7 : renderSystem() recevait un seul
 * blob pré-concaténé de 6 sources et tronquait en gardant la fin —
 * correct pour 1 source (design v1.5), backwards à 6 sources dans
 * l'ordre [historyCtx, goalCtx, embedCtx, ...] : l'historique réel
 * (1er du blob) sautait en premier sous budget serré, les enrichissements
 * optionnels (derniers du blob) survivaient. Comportement attendu
 * maintenant : goals/historique protégés, enrichissements sacrifiés.
 */
const test   = require("node:test");
const assert = require("node:assert/strict");
const ContextRenderer = require("../../lib/context-renderer");

test("budget serré : historique et goals survivent, trust/longterm sautent en premier", () => {
  const renderer = new ContextRenderer(150); // budget minuscule, volontaire
  const skill = { name: "energie", context: "", tools: "turn_on,turn_off" };

  const result = renderer.renderSystem(skill, {
    goals:       "Objectifs actifs : conso < 200kWh",
    history:     "Demande: allume le salon\n[Action: turn_on]\n[Résultat: OK]",
    embed:       "x".repeat(200),
    longterm:    "x".repeat(200),
    trust:       "x".repeat(200),
  }, { debugMode: true });

  assert.ok(result.included.includes("Objectifs actifs"), "les goals doivent survivre");
  assert.ok(result.included.includes("Historique récent"), "l'historique doit survivre");
  assert.ok(result.dropped.includes("Fiabilité des tools"), "trust doit être sacrifié en premier");
  assert.ok(result.dropped.includes("Mémoire long terme"), "longterm doit être sacrifié avant l'historique");
});

test("budget large : toutes les sources tiennent", () => {
  const renderer = new ContextRenderer(3000);
  const skill = { name: "s", context: "", tools: "" };
  const result = renderer.renderSystem(skill, {
    goals: "g", history: "h", embed: "e", longterm: "l", trust: "t",
  }, { debugMode: true });
  assert.equal(result.dropped.length, 1); // seul "Contraintes" est vide donc absent, jamais "dropped" par manque de budget
});

test("compat rétro : appel avec une simple string (comportement legacy)", () => {
  const renderer = new ContextRenderer(3000);
  const skill = { name: "s", context: "", tools: "" };
  const prompt = renderer.renderSystem(skill, "historique brut simple");
  assert.match(prompt, /historique brut simple/);
});

test("le contexte du skill est tronqué à 2 paragraphes si trop long", () => {
  const renderer = new ContextRenderer(100); // budget très petit, volontaire
  const longPara = "x".repeat(200); // chaque paragraphe dépasse déjà le budget skill à lui seul
  const skill = { name: "s", tools: "", context: [longPara, longPara, longPara, longPara].join("\n\n") };
  const prompt = renderer.renderSystem(skill, {});
  // Les 4 paragraphes identiques ne se distinguent pas par contenu — on vérifie
  // que le résultat est significativement plus court que les 4 réunis.
  assert.ok(prompt.length < (longPara.length * 3), "doit être tronqué bien en-deçà de 3+ paragraphes complets");
});
