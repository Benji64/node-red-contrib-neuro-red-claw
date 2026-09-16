# Contrats cognitifs

18 nœuds contractés — tous les nœuds qui traitent un `msg` dans le
graphe cognitif.

**3 nœuds explicitement exclus, pas oubliés :** `llm-config`,
`embed-config`, `redclaw-policy-config` — nœuds de configuration sans
handler `on("input")` cognitif.

## Format
Voir n'importe quel `.yaml`. Champs : `node`, `category`, `outputs`,
`description`, `reads`, `writes`, `forbidden`, `notes`.

## Mécanisme de validation
`lib/cognitive-contract.js` : tout champ modifié absent de `writes`
est une violation. `forbidden` enrichit seulement le message d'erreur
pour les pièges les plus tentants.

## Documentation générée
```bash
node scripts/generate-contract-docs.js   # régénère CONTRACTS.md
node scripts/check-contract-docs.js      # vérifie qu'il est à jour
```

## Analyse de graphe
`lib/cognitive-graph-analyzer.js` — deux règles structurelles,
testées contre l'architecture réelle avant livraison :
- **Règle A** — reflection ne doit jamais atteindre execution sans
  traverser un point de contrôle (decision/constraint/routing/interface).
- **Règle C** — tout cycle doit contenir routing ou execution (timeout
  vérifié sur callId dans ce projet).
