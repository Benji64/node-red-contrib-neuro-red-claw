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
ollama pull qwen2.5-coder:7b     # coding agent
ollama pull mxbai-embed-large    # embeddings sémantiques
```

---

## Architecture — 8 couches cognitives

```
COUCHE 8  Mémoire sémantique  embed-config · neuro-embed
COUCHE 7  Dashboard UI        neuro-chat · neuro-approval
COUCHE 6  Pensée divergente   redclaw-diverge
COUCHE 5  Réflexion           redclaw-reflect
COUCHE 4  Politiques          redclaw-policy
COUCHE 3  Observation ORA     redclaw-observe
COUCHE 2  Objectifs           redclaw-goal
COUCHE 1  Hub cognitif        redclaw-hub
COUCHE 0  Fondation           skill · orchestrateur · mcp-router · mcp-adapter
```

---

## 24 nœuds — palette `neuro-red-claw`

### Fondation

| Nœud | Rôle |
|------|------|
| `llm-config` | Config LLM — Ollama, OpenAI, Anthropic, LM Studio, LocalAI, REST |
| `redclaw-skill` | 1 nœud = 1 compétence. Auto-enregistrement dans le hub. |
| `redclaw-orchestrator` | Boucle agentique LLM + mémoire + tickets + instrumentation |
| `mcp-router` | Route les tool calls (N sorties + ⚡ retour). Sorties persistantes. |
| `mcp-adapter` | Adapte tout nœud Node-RED pour le MCP Router |
| `security-gate` | Validation, blocage, rate-limit, confirmation humaine |

### Couche cognitive

| Nœud | Rôle |
|------|------|
| `redclaw-hub` | Thalamus — registre vivant des skills, délégation inter-agents |
| `redclaw-goal` | Objectif mesurable persistant (minimize / maximize / reach) |
| `redclaw-observe` | Phase O du cycle ORA — agrège signaux en perception unifiée |
| `redclaw-policy` | 5 niveaux d'autorisation framework-agnostic (0 BLOCKED → 4 PROMOTED) |
| `redclaw-reflect` | Méta-cognition — lit ses propres tickets, détecte patterns |
| `redclaw-diverge` | Pensée divergente — N perspectives cognitives en parallèle |

### Mémoire sémantique

| Nœud | Rôle |
|------|------|
| `embed-config` | Config modèle d'embedding (Ollama, OpenAI, LocalAI, REST) |
| `neuro-embed` | Vectorise, stocke et recherche sémantiquement — réduit -80% tokens |

### Dashboard 2.0

| Nœud | Rôle |
|------|------|
| `neuro-chat` | Interface chat LLM — compatible Dashboard 2.0 |
| `neuro-approval` | File d'approbation des actions humaines |

### Coding Agent

| Nœud | Rôle |
|------|------|
| `rc-coding-skill` | Skill coding avec contexte projet |
| `rc-tool-bash` | Exécute des commandes shell |
| `rc-tool-read-file` | Lit un fichier (plage de lignes) |
| `rc-tool-write-file` | Crée ou remplace un fichier |
| `rc-tool-edit-file` | Remplacement ciblé (str_replace) |
| `rc-tool-search` | grep / find |
| `rc-tool-git` | Opérations git |
| `rc-tool-list-dir` | Liste un dossier |

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

---

## Flow de base

```
[Source] ──► [redclaw-skill] ──► [neuro-embed: both] ──► [redclaw-orchestrator]
                                       (contexte sémantique)        │
                              Output 2 ──► [neuro-embed: store]     │ Output 1
                                                          [security-gate]
                                                          [redclaw-policy]
                                                          [mcp-router]
                                                          [mcp-adapter]
                                                          [nœud Node-RED]
                                                          ⚡ [redclaw-orchestrator]
                                                          Output 2 → [neuro-chat]
```

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

### Chat LLM

```
[ui-text-input] ──► [neuro-chat] ──1──► [ui-template]
                         └──2──► [redclaw-skill] ──► [redclaw-orchestrator] Output2 ──► [neuro-chat]
```

```html
<!-- Template ui-template Dashboard 2.0 -->
<div v-for="m in msg.payload.conversations" :key="m.ts">
  <div :class="'msg-' + m.role">
    <b>{{ m.role === 'user' ? '👤' : '🤖' }}</b> {{ m.content }}
  </div>
</div>
```

### File d'approbation

```
[security-gate] Output2 ──► [neuro-approval] ──1──► [ui-template]
[ui-button ✅] ──► [change: topic=approve, payload={actionId}] ──► [neuro-approval] ──2──► [mcp-router]
[ui-button ✗]  ──► [change: topic=reject,  payload={actionId}] ──► [neuro-approval] ──3──► [log]
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
