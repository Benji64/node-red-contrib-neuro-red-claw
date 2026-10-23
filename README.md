# node-red-contrib-neuro-red-claw

> Système nerveux général d'agents IA pour Node-RED.
> Le graphe Node-RED **est** le graphe cognitif.

[![npm](https://badge.fury.io/js/node-red-contrib-neuro-red-claw.svg)](https://www.npmjs.com/package/node-red-contrib-neuro-red-claw)
[![Node-RED](https://img.shields.io/badge/Node--RED-%E2%89%A53.0.0-red)](https://nodered.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Vision

neuro-red-claw est un **framework d'agents IA cognitifs** pour Node-RED.
Pas une maison automatisée. Un **système nerveux général** applicable à tout domaine :

```
Smart Home · Hôpital · Usine · Smart City · Entreprise · Smart Building
```

Les nœuds sont des neurones. Les fils sont des synapses.
Les messages sont des signaux nerveux. Le graphe Node-RED **est** l'architecture cognitive.

---

## Installation

```bash
cd ~/.node-red
npm install node-red-contrib-neuro-red-claw
```

**LLM local :**
```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull gemma3:4b            # agent général
ollama pull qwen2.5-coder:7b     # utile SI node-red-contrib-neuro-red-claw-coding est installé
ollama pull mxbai-embed-large    # embeddings sémantiques
```

---

## Architecture — rôles reliés par le flow

La palette n'est pas une pile de couches à traverser dans un ordre imposé.
Chaque nœud a un rôle spécialisé ; les fils Node-RED déterminent les
relations et le chemin d'exécution. Un flow peut composer, par exemple,
perception, contexte, skills, mémoire, politiques, approbation et action
selon les besoins du domaine.

La phase active de migration, les preuves de validation et les écarts restant
à arbitrer sont suivis dans [`docs/PROGRESS.md`](docs/PROGRESS.md).

```text
Configuration ─┐
Perception ─────┼──► Contextualisation ─► Skills / orchestration ─► Action
Mémoire ────────┤              ▲                    │                  │
Objectifs ──────┤              │                    ├─ divergence     │
Politiques ─────┴──────────────┘                    └─ réflexion ◄── Observation
                                      │
                                Chat / approbation
```

Les catégories ci-dessous décrivent les responsabilités principales, pas
des frontières d'exécution. La palette `neuro-red-claw` contient **22 types
de nœuds**, conformément au manifeste `node-red.nodes` de `package.json`.

### Configuration — 3

| Nœud | Rôle |
|------|------|
| `llm-config` | Configure un backend LLM (Ollama, OpenAI, Anthropic, etc.). |
| `embed-config` | Configure le modèle et le backend d'embedding. |
| `redclaw-policy-config` | Fournit une configuration de politiques référencée explicitement. |

### Perception et contexte — 3

| Nœud | Rôle |
|------|------|
| `redclaw-observe` | Agrège des signaux et produit une perception unifiée (phase Observe d'ORA). |
| `neuro-context` | Assemble observations, tickets, objectifs et contraintes explicitement configurées. |
| `neuro-envelope` | Normalise et enrichit l'enveloppe cognitive des messages. |

### Skills, orchestration et routage — 5

| Nœud | Rôle |
|------|------|
| `redclaw-skill` | Déclare une compétence et peut charger un paquet Agent Skills local `SKILL.md`, avec empreinte de provenance (à auditer avant usage). |
| `redclaw-hub` | Expose le registre et route les délégations vers les skills câblés. |
| `redclaw-orchestrator` | Pilote la boucle agentique et propose un mode Tree Reasoner expérimental, limité aux réponses sans outils. |
| `mcp-router` | Route les appels d'outils vers leurs sorties configurées et reçoit leurs retours. |
| `mcp-adapter` | Adapte un nœud Node-RED pour son utilisation comme outil par le MCP Router. |

### Raisonnement, objectifs et réflexion — 3

| Nœud | Rôle |
|------|------|
| `redclaw-goal` | Gère des objectifs mesurables persistants. |
| `redclaw-diverge` | Lance plusieurs perspectives en parallèle et agrège leurs réponses. |
| `redclaw-reflect` | Analyse les tickets et exécutions passés pour détecter des tendances. |

### Mémoire et confiance — 3

| Nœud | Rôle |
|------|------|
| `neuro-embed` | Vectorise, stocke et recherche sémantiquement des contenus. |
| `neuro-longterm` | Consulte et gère la mémoire à long terme. |
| `neuro-trust` | Fournit le contexte de confiance associé aux compétences. |

### Gouvernance et sécurité — 4

| Nœud | Rôle |
|------|------|
| `redclaw-policy` | Évalue les actions selon des politiques à cinq niveaux (BLOCKED à PROMOTED). |
| `security-gate` | Applique validation, blocage, limitation de débit et confirmation selon sa configuration. |
| `neuro-approval` | Présente les actions soumises à approbation humaine et transmet leur décision. |
| `redclaw-response-review` | Met en attente une réponse du Tree Reasoner pour approbation ou rejet humain authentifié. |

### Interface — 1

| Nœud | Rôle |
|------|------|
| `neuro-chat` | Gère le chat réactif et les messages d'assistance proactifs pour Dashboard 2.0. |

### Capacités cognitives expérimentales

Le dépôt expose aussi des bibliothèques testées, opt-in et composables par
flow : modèle cognitif versionné, Tree Reasoner, Decision Engine,
instrumentation, framework expérimental et génération de candidats learning.
Elles ne constituent pas toutes des nœuds de palette et ne sont pas encore
raccordées en une boucle unique par défaut. En particulier, l'orchestrateur
existant conserve son chemin LLM → politique → sécurité → exécution.
Voir `docs/` pour les interfaces, limites et exemples.
Voir [docs/AGENT_SKILLS.md](docs/AGENT_SKILLS.md) pour importer des instructions
Agent Skills locales dans `redclaw-skill`.
Voir [docs/EXAMPLE_FLOW.md](docs/EXAMPLE_FLOW.md) pour déployer le flow
fonctionnel de l'assistant local Ollama.

La divergence en palette agrège des perspectives en parallèle ; elle n'est
pas à elle seule le Tree Reasoner.

### Domain packages séparés

`neuro-red-claw` est le framework — le système nerveux générique. Une
application vraiment distincte (coder, gérer une maison, un hôpital…)
est un **domain package** séparé, qui se compose avec ces 22 nœuds sans
jamais faire partie du core.

- **v2.7** — le coding agent (bash, git, fichiers) extrait : sa surface
  de sécurité (exécution shell) ne devrait pas être imposée à qui
  installe le framework pour un tout autre domaine.
- **v2.11 → v2.12** — le chat/l'approbation Dashboard 2.0 avaient été
  extraits par le même principe (zéro dépendance de code), puis
  **réintégrés** : contrairement au coding agent, ils ne portent aucun
  risque de sécurité propre, et la séparation créait un vrai piège —
  `neuro-approval` est le consommateur de référence d'Output 2 sur
  `redclaw-policy` (RESTRICTED/SUPERVISED), l'oublier dans un package à
  côté rendait facile de configurer des guardrails qui ne font rien.
  `redclaw-policy` détecte toujours ce cas au démarrage (oubli de
  câblage, pas d'installation) et avertit dans le canvas.

| Package | Fournit |
|---------|---------|
| [`node-red-contrib-neuro-red-claw-coding`](https://www.npmjs.com/package/node-red-contrib-neuro-red-claw-coding) | `rc-coding-skill`, `rc-tool-bash`, `rc-tool-read-file`, `rc-tool-write-file`, `rc-tool-edit-file`, `rc-tool-search`, `rc-tool-git`, `rc-tool-list-dir` |

---

## LLM supportés

| Backend | URL défaut | Notes |
|---------|-----------|-------|
| Ollama | `http://localhost:11434` | Gemma, Mistral, LLaMA, Qwen… |
| LM Studio | `http://localhost:1234` | OpenAI-compatible |
| LocalAI | `http://localhost:8080` | OpenAI-compatible |
| Jan | `http://localhost:1337` | OpenAI-compatible |
| OpenAI | `https://api.openai.com` | GPT-4o, GPT-4o-mini |
| Anthropic | `https://api.anthropic.com` | Claude |
| REST custom | configurable | Tout serveur OpenAI-compatible |

Timeout par défaut : **60s**.

## Modèles d'embedding supportés

| Modèle | Dims | Taille | Usage |
|--------|------|--------|-------|
| `mxbai-embed-large` | 1024 | ~670M | Excellent, recommandé |
| `nomic-embed-text` | 768 | ~274M | Léger, bon rapport qualité |
| `all-minilm` | 384 | ~45M | Ultra-léger pour Pi |
| `text-embedding-3-small` | 1536 | OpenAI API | Cloud |

Dans la palette, `embed-config` enregistre son fournisseur sous `backend` afin
de ne pas entrer en conflit avec le champ `type` réservé par Node-RED.
`neuro-embed` utilise `topK` pour le nombre de résultats ; les flows existants
qui contiennent l'ancien champ `k` restent lus à l'exécution et conservent
cette valeur lorsqu'on ouvre leur panneau d'édition.

---

## Flow de base

```
[Source] ──► [redclaw-skill] ──► [neuro-embed: both] ──► [redclaw-orchestrator]
                                       (contexte sémantique)        │
                              Output 2 ──► [neuro-embed: store]     │ Output 1
                                                          [redclaw-policy]
                                                                │
                                                          [security-gate]
                                                                │
                                                          [mcp-router]
                                                                │
                                                          [mcp-adapter]
                                                                │
                                                          [nœud Node-RED]
                                                                │
                                                          ⚡ [redclaw-orchestrator]
                                                          Output 2 → [neuro-chat]
```

`security-gate` doit intervenir après `redclaw-policy` afin que son autorisation
à usage unique porte sur les paramètres finaux transmis au `mcp-router`.

---

## Mémoire sémantique — Réduction du contexte

**Sans embedding (sliding window) :**
```
20 derniers messages → ~4000 chars → tout le contexte récent, pertinent ou non
```

**Avec embedding (recherche sémantique) :**
```
Top-5 similaires → ~800 chars → uniquement le contexte pertinent à la question
Gain : -80% tokens · mémoire longue terme · pertinence sémantique
```

### Câblage mémoire sémantique

```
[redclaw-skill] ──► [neuro-embed: both] ──1──► [redclaw-orchestrator]
                          │                     msg.embed_context = contexte pertinent
                          └──2──► [log: rien trouvé]

[redclaw-orchestrator] Output2 ──► [neuro-embed: store]
```

### Modes de neuro-embed

| Mode | Rôle |
|------|------|
| `both` | Stocke + Recherche — mémoire conversationnelle complète |
| `store` | Indexation uniquement |
| `search` | Récupération uniquement |
| `auto` | Lit `msg.embed_action` |

### Persistance vecteurs

```
~/.node-red/redclaw-vectors/{storeName}.json
```

---

## Cycle ORA (Observe → Reason → Act)

```
[Capteurs] ──► [redclaw-observe] ──► [redclaw-skill] ──► [redclaw-orchestrator]
                     ↑                                            │ Reason
                     │                                     [mcp-router] ──► [Act]
                     └──────────────── feedback ─────────────────────────────────┘
```

---

## Multi-agents (Hub)

```
[Orch CEO] Output1 ──► [redclaw-hub]
  ├─ 1 ──► [skill: energie] ──► [Orch Energie] Output2 ──► [Hub]
  ├─ 2 ──► [skill: confort] ──► [Orch Confort] Output2 ──► [Hub]
  └─ ⚡ ──► [Orch CEO] ──► réponse synthétisée
```

---

## Pensée divergente

```
[Signal] ──► [redclaw-diverge]
  ├─ 1 ──► [skill: angle économique] ──► [Orch A] ──► [diverge entrée]
  ├─ 2 ──► [skill: angle sécurité]   ──► [Orch B] ──► [diverge entrée]
  └─ ⚡ ──► [skill: synthèse] ──► décision finale
```

---

## MCP Adapter — Transformations

**Transformation entrée :**
```js
if (msg.routeur.params.state === "ON") {
  msg.payload = { dps: 1, set: true };
}
return msg;
```

**Transformation sortie :**
```js
// Variable "adaptateur" pré-initialisée avec callId
adaptateur.success = true;
adaptateur.state   = msg.payload?.data?.dps?.["1"] ? "ON" : "OFF";
```

**Filtre de corrélation (hub multi-capteurs) :**
```js
// Ignore les updates périodiques (Tuya hub, MQTT multi-topics, WebSocket…)
return msg.payload?.data?.dps?.["1"] !== undefined;
```

---

## Politiques

```json
[
  { "id": "block_guest", "name": "Bloquer invités",
    "condition": "agent.role === 'guest'",
    "level": 0, "priority": 90, "scope": "all" },
  { "id": "confirm_delete", "name": "Confirmer suppression",
    "condition": "context.tool?.includes('delete')",
    "level": 1, "priority": 80, "scope": "all" },
  { "id": "supervise_night", "name": "Supervision nocturne",
    "condition": "new Date().getHours() >= 22 || new Date().getHours() < 6",
    "level": 2, "priority": 70, "scope": "all" }
]
```

**Niveaux :** 0 BLOCKED · 1 RESTRICTED · 2 SUPERVISED · 3 ALLOWED · 4 PROMOTED

---

## Dashboard 2.0

### Chat LLM — flux réactif (question → réponse)

```
[ui-text-input] ──► [neuro-chat] ──1──► [ui-template CHAT]
                         │         └──3──► [ui-table historique CHAT]
                         └──2──► [redclaw-skill] ──► [redclaw-orchestrator] Output2 ──► [neuro-chat]
```

```html
<!-- Template ui-template Dashboard 2.0 — Chat -->
<div v-for="m in msg.payload.conversations" :key="m.ts">
  <div :class="'msg-' + m.role">
    <b>{{ m.role === 'user' ? '👤' : '🤖' }}</b> {{ m.content }}
  </div>
</div>
```

### Assistance — flux proactif (poussé sans question)

Strictement séparé du chat — un message assistance n'apparaît jamais
dans l'historique de conversation, et inversement.

```
[redclaw-goal] Output2 (atteint)  ──► [neuro-chat] ──4──► [ui-template ASSISTANCE]
[redclaw-reflect] Output1         ──►        ↑
[redclaw-observe] Output1         ──►        ↑
```

Ces 3 sources cœur sont reconnues automatiquement, sans nœud `change`.
Pour toute autre source :
```js
msg.chat_kind     = "proactive";   // requis
msg.chat_source   = "ma-source";   // optionnel
msg.chat_category = "warning";     // optionnel : info|success|warning|alert
```

```html
<!-- Template ui-template Dashboard 2.0 — Assistance -->
<div v-for="a in msg.payload.items" :key="a.ts" :class="'assist-' + a.category">
  <b>{{ a.source }}</b> — {{ a.content }}
</div>
```

### File d'approbation — consommateur de référence de redclaw-policy Output 2

```
[redclaw-policy] Output2 (RESTRICTED/SUPERVISED) ──► [neuro-approval] ──1──► [ui-template]
[ui-button ✅] ──► [change: topic=approve, payload={actionId}] ──► [neuro-approval] ──2──► [mcp-router]
[ui-button ✗]  ──► [change: topic=reject,  payload={actionId}] ──► [neuro-approval] ──3──► [log]
```

Le câblage Dashboard historique utilise des identifiants déclaratifs et ne
prouve pas l'identité du réviseur. Pour exiger une revue authentifiée, activez
**Exiger une revue authentifiée** sur `neuro-approval` : les décisions Dashboard
directes sont alors refusées. Utilisez l'API admin Node-RED
`POST /redclaw/approvals/:nodeId/:actionId` avec `{"decision":"approve"}` ou
`{"decision":"reject"}` et la permission `flows.write`. Le réviseur est dérivé
de l'utilisateur authentifié; l'option est désactivée par défaut pour préserver
les flows existants. Le reçu `redclaw_approval` indique `human_required`,
`human_decision` et `human_decided_at`; `human_decided_by` n'est renseigné que
pour un utilisateur authentifié, et `approved_by` uniquement lors d'une
approbation authentifiée. Cette décision humaine ne remplace pas la validation
finale de l'autorisation d'action.
Lorsque la demande revient à l'orchestrateur avec son reçu, celui-ci ajoute
l'intervention à la trace cognitive active sous le même `request_id`. Pour
tracer également les refus, reliez la sortie 3 de `neuro-approval` au retour
de l'orchestrateur, en plus du nœud de notification. Les refus, timeouts,
évictions et blocages d'autorisation sont traités comme des échecs d'outil;
seules les décisions humaines explicites sont comptées comme interventions.

---

## Contrats cognitifs

18 nœuds contractés — reads/writes/forbidden par nœud, un validateur
qui détecte toute mutation hors contrat pendant les tests (diff par
valeur, jamais par référence), un analyseur qui vérifie deux
propriétés structurelles du câblage d'un flow. Voir
[`contracts/README.md`](contracts/README.md) et
[`contracts/CONTRACTS.md`](contracts/CONTRACTS.md) (généré, ne jamais
éditer à la main).

L'instrumentation des exécutions cognitives et ses mesures reproductibles
sont décrites dans [`docs/INSTRUMENTATION.md`](docs/INSTRUMENTATION.md).
Le protocole de comparaison baseline/linéaire/arborescent est décrit dans
[`docs/EXPERIMENT_FRAMEWORK.md`](docs/EXPERIMENT_FRAMEWORK.md).
La boucle observation/réflexion/candidats de learning est détaillée dans
[`docs/LEARNING.md`](docs/LEARNING.md).
Pour relier une observation différée à une exécution terminée, conservez son
`redclaw_request_id`, puis reliez `redclaw-observe` Output 2 à l'orchestrateur.
Avec `runStorageDir`, les suivis corrélés sont enregistrés séparément du journal
immuable des runs; sans cette option, ils restent en mémoire. Voir
[`docs/INSTRUMENTATION.md`](docs/INSTRUMENTATION.md).

```bash
node scripts/generate-contract-docs.js   # régénère la doc
node scripts/check-contract-docs.js      # vérifie qu'elle est à jour
```

---

## Persistance

```
~/.node-red/redclaw-memory/     → 1 JSON par skill (conversation)
~/.node-red/redclaw-tickets/    → tickets.jsonl (audit log immuable)
~/.node-red/redclaw-goals/      → goals.json (objectifs)
~/.node-red/redclaw-vectors/    → {storeName}.json (vecteurs embedding)
```

---

## API REST

```
GET /redclaw/sessions            → sessions mémoire actives
GET /redclaw/stats               → stats instrumentation + tickets
GET /redclaw/tickets             → ?skill=x&status=y&n=20
GET /redclaw/tickets/:id         → ticket par ID
GET /redclaw/tickets/history/disk→ depuis fichier JSONL
GET /redclaw/hub                 → registre des skills
GET /redclaw/hub/goals           → objectifs actifs
GET /redclaw/hub/snapshot        → snapshot cognitif complet
GET /redclaw/policies            → politiques actives
GET /redclaw/vectors/:store      → stats du vector store
```

---

## Contribuer

```bash
git clone https://github.com/neuro-red-claw/node-red-contrib-neuro-red-claw
cd node-red-contrib-neuro-red-claw
npm install
cd ~/.node-red && npm install /chemin/vers/node-red-contrib-neuro-red-claw
npm publish --access public
```

---

## Licence

MIT © neuro-red-claw Project
