# Contrats cognitifs — neuro-red-claw

**Généré automatiquement depuis `contracts/*.yaml` — ne pas éditer à la main.**
Régénérer : `node scripts/generate-contract-docs.js` après toute modification d'un .yaml.

18 nœuds contractés. Nœuds de configuration (`llm-config`, `embed-config`, `redclaw-policy-config`) explicitement exclus — voir `contracts/README.md`.

## Interface (entrée/sortie humaine)

### `neuro-approval`

**Sorties :** 3

**Lit :** `redclaw`, `redclaw.tool`, `redclaw.params`, `redclaw_call_id`, `redclaw_policy`, `redclaw_policy.reason`, `redclaw_security`, `redclaw_security.reason`, `topic`, `payload`
**Écrit :** `payload`, `redclaw_approval`
**Interdit (piège documenté) :** `redclaw.tool`, `redclaw.params`

> Approuve/refuse seulement — renvoie le msg original inchangé côté approbation.

---

### `neuro-chat`

**Sorties :** 4

**Lit :** `payload`, `topic`, `redclaw`, `redclaw.finalResponse`, `redclaw.success`, `chat_kind`, `chat_source`, `chat_category`, `redclaw_goal_achieved`, `redclaw_reflect`, `ora_perception`, `redclaw_hub_context`
**Écrit :** `payload`, `sessionId`, `topic`, `ui_payload`, `ui_role`, `ui_ts`, `ui_source`, `ui_category`
**Interdit (piège documenté) :** `redclaw.tool`, `redclaw_policy`

> Un message proactif ne doit jamais apparaître dans l'historique du chat réactif, et inversement.

---

### `redclaw-skill`

**Sorties :** 1

**Lit :** `payload`, `sessionId`, `redclaw_hub_call`
**Écrit :** `redclaw`, `redclaw.userMessage`, `redclaw.skill`, `sessionId`, `redclaw_hub_callId`
**Interdit (piège documenté) :** `redclaw.tool`, `redclaw_call_id`

> Auto-filtre les messages de délégation Hub qui ne le ciblent pas — les ignore silencieusement plutôt que de les enrichir à tort.

---

## Perception

### `redclaw-observe`

**Sorties :** 2

**Lit :** `payload`, `topic`, `ora_source`, `ora_key`, `ora_unit`, `ora_ttl`, `ora_trigger`
**Écrit :** `payload`, `ora_perception`, `sessionId`
**Interdit (piège documenté) :** `redclaw.tool`, `redclaw_goal`, `redclaw_policy`

> Ne décide jamais d'agir — produit une observation, jamais une action.

---

## Context Builder

### `neuro-context`

**Sorties :** 2

**Lit :** `redclaw`, `redclaw.skill`, `redclaw_hub_call`, `sessionId`
**Écrit :** `neuro.context`, `context_summary`
**Interdit (piège documenté) :** `redclaw.tool`, `redclaw_goal`, `redclaw_policy`

> Référence explicite optionnelle à redclaw-policy-config — jamais de recherche globale par nom de skill.

---

## Mémoire

### `neuro-embed`

**Sorties :** 2

**Lit :** `payload`, `embed_action`, `sessionId`, `redclaw.skill`, `redclaw.userMessage`
**Écrit :** `payload`, `embed_context`, `embed_results`, `embed_vector`, `embed_chars`, `embed_retrieved`, `embed_error`
**Interdit (piège documenté) :** `redclaw.tool`, `goal_context`

> embed_context est une lecture passive côté orchestrateur — jamais injecté sans câblage explicite.

---

### `neuro-longterm`

**Sorties :** 2

**Lit :** `payload`, `longterm_action`, `skillName`, `reflect_skill`
**Écrit :** `payload`, `longterm_context`, `longterm_items`
**Interdit (piège documenté) :** `redclaw.tool`, `redclaw_policy`

> record()/reinforce() retournent des copies indépendantes (v2.10) — jamais la référence mutable interne.

---

### `neuro-trust`

**Sorties :** 2

**Lit :** `redclaw.skill`, `redclaw.tool`, `sessionId`, `payload`
**Écrit :** `redclaw_trust`, `trust_context`
**Interdit (piège documenté) :** `redclaw.tool`, `redclaw_policy`

> Formule de lissage de Laplace — converge avec l'usage plutôt qu'un ratio brut trompeur.

---

## Objectifs (Goals)

### `redclaw-goal`

**Sorties :** 2

**Lit :** `payload`, `redclaw_goal`, `redclaw_goal.action`
**Écrit :** `payload`, `redclaw_goal`, `goal_context`
**Interdit (piège documenté) :** `redclaw.tool`, `redclaw.params`, `redclaw_policy`

> goal_context n'est lu par l'orchestrateur QUE si ce nœud est câblé sur son chemin — lecture passive.

---

## Contraintes (Policies)

### `redclaw-policy`

**Sorties :** 3

**Lit :** `redclaw`, `redclaw.tool`, `sessionId`, `ora_perception`, `ora_perception.observations`, `neuro`
**Écrit :** `redclaw_policy`, `redclaw.params`, `payload`
**Interdit (piège documenté) :** `redclaw.tool`

> v2.5 — évaluation strictement locale, plus de singleton global. Détecte au démarrage si Output 2 n'a aucun consommateur câblé. payload n'est réécrit QUE sur Output 3 (BLOCKED), remplacé par la raison du refus — trouvé par le test d'intégration du contrat.

---

### `security-gate`

**Sorties :** 3

**Lit :** `redclaw.tool`, `redclaw.params`, `payload`, `sessionId`
**Écrit :** `redclaw_confirm`
**Interdit (piège documenté) :** `redclaw.tool`

> N'écrit jamais dans redclaw_policy — espace de noms distinct, pas encore unifié avec le moteur de politiques (dette technique connue).

---

## Analyse / Hypothèses

### `redclaw-diverge`

**Sorties :** dynamic

**Lit :** `payload`, `redclaw_diverge_return`, `redclaw_diverge_return.divergeId`, `redclaw_diverge_return.lensName`, `redclaw_diverge_return.response`
**Écrit :** `redclaw_lens`, `redclaw_diverge_id`, `redclaw_frame_prompt`, `redclaw_diverge`
**Interdit (piège documenté) :** `redclaw.tool`, `redclaw_policy`

> Chevauche conceptuellement un "Decision Engine" évoqué dans des propositions externes — à clarifier avant d'ajouter un nœud doublon.

---

## Décision

### `redclaw-orchestrator`

**Sorties :** 3

**Lit :** `payload`, `redclaw.skill`, `redclaw.userMessage`, `redclaw_call_id`, `redclaw_llm_id`, `redclaw_hub_callId`, `redclaw_cmd`, `sessionId`, `goal_context`, `trust_context`, `longterm_context`, `context_summary`, `embed_context`
**Écrit :** `redclaw.tool`, `redclaw.params`, `redclaw_call_id`, `redclaw_request_id`, `redclaw_error`, `payload`
**Interdit (piège documenté) :** `redclaw_policy`, `redclaw_trust`

> Seul nœud qui écrit redclaw.tool — c'est la frontière décision/exécution du système.

---

## Exécution

### `mcp-adapter`

**Sorties :** 2

**Lit :** `routeur`, `routeur.tool`, `routeur.params`, `routeur.callId`, `payload`, `redclaw_call_id`
**Écrit :** `payload`, `redclaw_call_id`, `adaptateur`, `adaptateur.callId`
**Interdit (piège documenté) :** `redclaw.tool`, `redclaw_policy`

> "adaptateur" pré-initialisé avec { callId } avant le code utilisateur. Un filtre de corrélation peut ignorer un msg sans jamais écrire — comportement légitime, pas une violation.

---

### `mcp-router`

**Sorties :** dynamic

**Lit :** `redclaw.tool`, `redclaw.params`, `redclaw_call_id`, `adaptateur`, `adaptateur.callId`
**Écrit :** `routeur`, `routeur.tool`, `routeur.params`, `routeur.callId`, `payload`, `redclaw_call_id`, `redclaw_error`
**Interdit (piège documenté) :** `redclaw.tool`, `redclaw_policy`

> v2.8 — lit adaptateur.callId en priorité, redclaw_call_id en repli (fix du décalage de contrat découvert par test réel).

---

## Réflexion

### `redclaw-reflect`

**Sorties :** 2

**Lit :** `payload`, `reflect_skill`, `reflect_n`
**Écrit :** `payload`, `redclaw_reflect`, `redclaw_adjustments`
**Interdit (piège documenté) :** `redclaw.tool`

> RÈGLE STRUCTURELLE : sa sortie ne doit jamais être câblée directement vers un nœud stage=execution — vérifié par le graph analyzer.

---

## Routage (Hub)

### `neuro-envelope`

**Sorties :** 2

**Lit :** `payload`, `neuro`, `neuro.trace`
**Écrit :** `neuro`, `neuro.id`, `neuro.type`, `neuro.source`, `neuro.trace`
**Interdit (piège documenté) :** `redclaw.tool`, `redclaw_policy`

> Copy-on-write systématique (v2.6) — un simple {...msg} en amont ne peut jamais faire fuiter une mutation.

---

### `redclaw-hub`

**Sorties :** dynamic

**Lit :** `payload`, `sessionId`, `redclaw_hub`, `redclaw_hub.action`, `redclaw_hub.question`, `redclaw_hub.target`, `redclaw_hub_return`
**Écrit :** `payload`, `sessionId`, `redclaw_hub_call`
**Interdit (piège documenté) :** `redclaw.tool`, `redclaw_policy`, `goal_context`

> Route par nom vers des sorties explicitement câblées — jamais de recherche globale implicite.

---
