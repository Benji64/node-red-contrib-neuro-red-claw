# Changelog — node-red-contrib-redclaw

## [1.5.0] — 2025

### Nouveautés v1.5

#### Context Renderer (`lib/context-renderer.js`)
- Compression du contexte envoyé au LLM pour rester dans le budget token
- Budget configurable dans l'orchestrateur (défaut: 3000 tokens ≈ 12 000 chars)
- Priorité de compression : exemples longs → historique ancien → contexte skill
- L'historique récent est toujours préservé en priorité

#### Instrumentation (`lib/instrumentation.js`)
- `request_id` court (8 chars) propagé dans tout le pipeline via `msg.redclaw_request_id`
- Tracking par requête : skill, steps LLM, tool calls (succès/échec), tokens estimés, durée
- Endpoint `GET /redclaw/stats` — stats sur les 50 dernières requêtes
- Bouton "Voir les stats v1.5" dans la config de l'orchestrateur
- Logs structurés : `[abc12345] skill:domotique 2llm tools:[turn_on:✓] ~320tk 1240ms ✓`

#### Orchestrateur — améliorations
- Utilise le Context Renderer pour le system prompt
- `tokenBudget` configurable dans la config du nœud
- `request_id` visible dans les outputs `msg.redclaw.request_id`
- Durée de traitement affichée dans le statut du nœud : `✓ 1240ms`
- Instrumentation des appels LLM et tool calls

---

## [1.0.0] — 2025

### Architecture initiale
- Pipeline : `redclaw-skill` → `agent-orchestrator` → `mcp-router` → `mcp-adapter`
- Protocole `msg.routeur` / `msg.adaptateur` avec `callId`
- Mémoire persistante : 1 fichier JSON par skill
- Boucle agentique multi-étapes
- Nœuds coding : bash, read/write/edit file, search, git, list-dir
- Security Gate avec blocage/confirmation/rate-limit
- Support LLM : Ollama, OpenAI, Anthropic, LM Studio, LocalAI, Jan, REST
- Timeout 60s par défaut pour modèles locaux
- Filtre messages périodiques dans mcp-adapter (callId requis)
- Sorties mcp-router persistantes au redémarrage (input hidden)
- Variable `adaptateur` dans outputTransform de mcp-adapter
