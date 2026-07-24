# Changelog — node-red-contrib-neuro-red-claw

## [2.13.0]

### neuro-chat — deux flux strictement séparés
Jusqu'ici un seul historique mélangeait tout ce qui transitait par le
nœud. Séparé en deux flux indépendants, jamais mélangés :

- **CHAT** (réactif) — question utilisateur → réponse LLM. Comportement
  inchangé pour qui était déjà câblé sur Outputs 1-3.
- **ASSISTANCE** (proactif, nouveau) — messages poussés sans question
  préalable : objectif atteint (`redclaw-goal`), insight de réflexion
  (`redclaw-reflect`), observation notable (`redclaw-observe`) — ces 3
  sources cœur sont reconnues automatiquement, aucun nœud `change`
  nécessaire. Toute autre source : `msg.chat_kind = "proactive"`
  (+ `chat_source`/`chat_category` optionnels). Nouvel Output 4 dédié.

Verrouillé par 5 tests, dont un qui envoie des messages des deux types
entremêlés et vérifie qu'aucun ne fuite dans le mauvais flux — c'est le
comportement qui compte le plus ici, pas juste le routage isolé.

Aucune persistance disque sur les deux flux — perdu au redémarrage,
documenté clairement dans l'aide du nœud (contrairement à
`conversation-memory.js` de l'orchestrateur, qui lui persiste).

---



### Retour en arrière assumé — Dashboard 2.0 refusionné dans le core
v2.11 avait extrait `neuro-chat`/`neuro-approval` sur le même critère
que le coding agent (zéro dépendance de code). Après réflexion, le
critère ne suffisait pas : contrairement à `rc-tool-bash` (exécution
shell, vrai risque de sécurité), le dashboard ne porte aucun risque
propre — et sa séparation avait *créé* le piège Output 2 corrigé la
veille (RESTRICTED configuré sans le bon package installé = guardrail
silencieusement mort). Trois packages à synchroniser pour un gain de
sécurité nul ne se justifiait pas. Fusionné : 19 → 21 nœuds.

Le coding agent reste séparé — lui a un vrai motif de sécurité.

La détection au démarrage de `redclaw-policy` (Output 2 non câblé)
reste utile même nœuds bundlés : elle protège contre l'oubli de
câblage dans un flow donné, pas seulement l'absence d'installation
d'un package. Message ajusté en conséquence (« inclus dans ce package »
plutôt que « installer le package séparé »).

---



### Extraction — Dashboard 2.0 devient un domain package séparé
`neuro-chat`/`neuro-approval` n'avaient aucune dépendance de code vers
le core ni vers `node-red-dashboard` (vérifié avant extraction, même
méthode que pour le coding agent en v2.7) — ce sont des nœuds
d'interface qui pilotent un agent déjà créé, pas des briques cognitives.
Extraits vers `node-red-contrib-neuro-red-claw-dashboard`. Core :
21 → 19 nœuds.

Point d'attention soulevé après coup, à juste titre : ce ne sont pas de
simples extras UI. `neuro-approval` est l'implémentation de référence
du contrôle humain que `redclaw-policy` attend pour RESTRICTED/
SUPERVISED (timeout + auto-reject) ; `neuro-chat` est la façon
principale de parler à un agent. La séparation en package reste
correcte architecturalement, mais elle crée un vrai piège : configurer
RESTRICTED sans installer ce package laisse Output 2 sans consommateur
— l'action n'est ni autorisée ni refusée, elle part et disparaît en
silence (comportement standard de Node-RED pour une sortie non câblée).

### Fix de robustesse — détection proactive au démarrage
`redclaw-policy` scanne maintenant ses politiques (locales + partagées
via `redclaw-policy-config`) au démarrage : si au moins une peut
produire RESTRICTED/SUPERVISED et qu'Output 2 n'a aucun fil câblé,
avertit clairement dans les logs et affiche `⚠️ Output 2 non câblé`
dans le canvas — plutôt que de laisser l'utilisateur découvrir que ses
guardrails ne font rien uniquement en constatant qu'une action reste
bloquée sans jamais comprendre pourquoi. Verrouillé par 3 tests via
`node-red-node-test-helper` + `RED.log.addHandler()`.

### Incident d'environnement
Le répertoire de travail a disparu intégralement en cours de session
(deuxième occurrence, plus large que celle notée en v2.10). Reconstruit
depuis le dernier zip livré et confirmé, changements de ce tour
réappliqués avec vérification par relecture après chaque édition.
Aucune perte finale, mais la cause reste externe à ce projet — à
surveiller si ça se reproduit.

---



### Audit systématique — même bug, cherché partout où il pouvait se cacher
Après les fixes v2.8 (goal-store) et v2.6 (neuro-message), grep mécanique
de toutes les libs pour la même signature exacte : une méthode qui mute
en place un objet stocké dans une Map interne, puis retourne (ou expose
via get/all) cette référence mutable. Trouvé et corrigé aux mêmes
endroits structurellement identiques :

- **`longterm-memory.js`** — `reinforce()` mutait en place, exactement
  comme `goal-store.update()`. Le cas d'usage central du module ("un
  souvenir répété gagne en confiance") est précisément le scénario qui
  aurait fait fuiter une comparaison avant/après.
- **`skill-registry.js`** — `get()`/`all()` exposaient la référence
  brute, mutable par `touch()`/`unregister()`. Pas de bug concret
  démontrable dans l'usage actuel (rien ne garde de référence assez
  longtemps aujourd'hui), corrigé par principe — c'est exactement ce
  raisonnement ("aucun code actuel n'en profite") qui avait laissé
  vivre le bug du singleton policy-engine jusqu'à sa découverte.
- **`ticket-store.js`** — `get()`/`recent()` rendus défensifs. `create()`
  garde intentionnellement son comportement actuel (référence vivante)
  : c'est un builder-pattern à un seul appelant qui thread le même
  ticket à travers `addToolCall`/`complete`/`fail` dans une seule
  requête — différent du bug, pas la même classe de risque.
- **`vector-store.js`** — `get()` rendu défensif par la même discipline,
  bien qu'aucune méthode ne mute un doc après insertion (moindre
  priorité, corrigé quand même : le coût est nul).
- **`skill-trust.js`** — vérifié sain : `_computeTrust()` construit déjà
  un objet frais à chaque lecture, aucune référence interne exposée.

Verrouillé par 7 nouveaux tests (`longterm-memory.test.js`,
`skill-registry.test.js`, +1 dans `ticket-store.test.js`).

Note de méthode : la première tentative de fix sur `ticket-store.js`
n'avait en réalité pas atteint le fichier malgré une confirmation
d'outil positive — détecté uniquement parce que la suite de tests a
été relancée plutôt que la correction supposée acquise. Reproductible :
toujours relire un fichier juste après édition avant d'enchaîner.

---



### Tests end-to-end contre un vrai serveur Node-RED
`test/e2e/real-server.test.js` — démarre un VRAI processus `node-red`
(pas le harness simulé de `node-red-node-test-helper`), déploie un vrai
`flows.json` tel qu'il serait stocké sur disque, pilote via une vraie
requête HTTP cliente (`fetch` natif Node 18+), observe la vraie réponse.

Motivation précise : le fix historique des sorties dynamiques de
`mcp-router` (`outputs` dans `defaults` + `<input type="hidden">` pour
que Node-RED les persiste et les recrée) avait été découvert et corrigé
à la main, jamais vérifié automatiquement. Le second test reproduit
exactement ce scénario — déployer, requêter, **redéployer le même flow
via l'Admin API réelle** (`POST /flows`, simulateur d'un clic Deploy),
requêter à nouveau, comparer les deux réponses et le wiring persistant.
Les deux passent : comportement identique avant/après, 2 sorties
recréées correctement.

Isolé dans `test/e2e/` (plus lent, ~7-8s, vrai boot serveur) plutôt que
`test/nodes/`. Suite complète : 42 tests, tous verts.

---



### Suite de tests fonctionnelle — enfin réelle, pas juste "le fichier se charge"
La CI ne vérifiait jusqu'ici que la requérabilité de chaque nœud — les
bugs trouvés en v2.5/v2.6 (singleton policy, mutation de trace) ne l'
auraient jamais attrapée. Mise en place de `node --test` (runtime natif
Node 18+, zéro dépendance ajoutée pour les libs) + `node-red-node-test-helper`
(officiel, pour le comportement de câblage réel des nœuds) :
- `test/lib/` — 26 tests sur `policy-engine`, `neuro-message`,
  `context-renderer`, `skill-trust`, `goal-store`, `ticket-store`,
  chacun verrouillant un bug historique précis (commenté dans le test).
- `test/nodes/` — 14 tests via `helper.load()`, dont un test qui déploie
  **deux nœuds `redclaw-policy` dans le même flow réel**, même scope,
  pour prouver au niveau runtime — pas juste sur la fonction pure — que
  le fix v2.5 tient. Un test d'intégration `mcp-router` + `mcp-adapter`
  câblés ensemble avec un helper simulant un nœud Tuya.
- `npm test` lancé en CI sur Node 20.x/22.x (18.x reste couvert par
  le check de requérabilité existant — `describe`/`it` de `node:test`
  n'y sont qu'expérimentaux, non vérifié dans cette CI).

### Fix — référence mutable dans goal-store.js
`update()` mutait en place l'objet stocké dans la Map interne et
retournait cette même référence. Deux appels successifs sur le même
objectif faisaient pointer les DEUX valeurs de retour vers le même
objet muté deux fois — la première photo de progression se retrouvait
silencieusement écrasée par la seconde dès qu'un appelant gardait les
deux résultats pour comparer une évolution dans le temps. Trouvé par
`test/lib/goal-store.test.js`, pas par relecture manuelle. `get()`
rendu défensif par la même occasion ; `redclaw-goal.js` (action
`pause`) corrigé pour passer par `upsert()` au lieu de muter l'objet
retourné par `get()` à la main.

### Fix — décalage de contrat callId entre mcp-router et mcp-adapter
`mcp-adapter` envoie `msg.adaptateur.callId` comme source de vérité
documentée. `mcp-router` lisait en réalité `msg.redclaw_call_id`, avec
une vérification croisée sur `msg.adaptateur._callId` (typo — le champ
réel n'a pas d'underscore, donc cette vérification ne se déclenchait
jamais). Ça fonctionnait par accident tant que `redclaw_call_id` était
fidèlement hérité par spread tout du long — le scénario "un nœud
intermédiaire ne préserve pas msg", explicitement anticipé et discuté
tôt dans le projet, aurait cassé la résolution silencieusement (timeout
plutôt qu'erreur claire). Trouvé par
`test/nodes/mcp-router.test.js` en simulant fidèlement ce que
`mcp-adapter` envoie réellement, pas un raccourci de test. `callId` lit
maintenant `msg.adaptateur.callId` en priorité, `msg.redclaw_call_id`
en repli.

---



### Fix — priorité de troncature du contexte (voir v2.6 pour le contexte du bug)
`context-renderer.js` recevait un seul blob pré-concaténé de 6 sources
(historique, goals, embed, contexte cross-skills, habitudes, fiabilité)
et tronquait en gardant la fin — correct quand c'était 1 source
(historique seul, design v1.5), backwards devenu incorrect à 6 sources
dans cet ordre : sur budget serré, l'historique réel (1er du blob) était
coupé en premier, les enrichissements optionnels (derniers du blob)
préservés. `renderSystem()` accepte maintenant des sources nommées avec
priorité explicite : goals/constraints/historique protégés en premier,
embed/longterm/trust sacrifiés en premier si le budget manque. Testé à
budget minuscule (150 tokens) : historique et goals survivent intacts,
fiabilité et habitudes sautent entièrement — comportement inverse
confirmé de l'ancien bug.

### Extraction — coding agent devient un domain package séparé
`rc-coding-skill` + les 7 `rc-tool-*` n'ont jamais eu de dépendance vers
le code du core (vérifié : zéro `require("../lib/...")` croisé). Les
garder bundlés imposait leur surface de sécurité (exécution shell
arbitraire) à quiconque installe le framework pour un tout autre domaine.
Extraits vers `node-red-contrib-neuro-red-claw-coding`, package séparé
qui se compose avec le core dans Node-RED sans jamais l'importer en code
— même modèle que `node-red-contrib-mcp-tuya`. Core : 29 → 21 nœuds.

---



### Standard de message — enfin porteur dans le pipeline cœur
`neuro-envelope` et `msg.neuro` existaient depuis la v2.3 mais restaient un
utilitaire optionnel à côté du chemin réel des messages : aucun nœud du
pipeline cœur ne le lisait ni ne l'enrichissait. Corrigé :
- `redclaw-skill`, `redclaw-orchestrator`, `mcp-router`, `mcp-adapter`,
  `security-gate`, `redclaw-policy` contribuent désormais chacun leur
  propre entrée à `msg.neuro.trace` — **mais seulement si `msg.neuro`
  existe déjà** (l'utilisateur adopte le standard en posant un seul
  `neuro-envelope: wrap` en entrée de flow ; rien n'est jamais forcé).
- Aucun de ces ajouts ne lit d'état global : chaque nœud ne touche que
  le message qui transite déjà physiquement par son propre fil. C'est
  la distinction établie avec le fix v2.5 sur `redclaw-policy` : de la
  comptabilité locale sur des données déjà en main, pas une consultation
  d'un registre partagé qui changerait le comportement d'un autre nœud
  non câblé.

### Fix — pollution croisée de trace entre branches parallèles
`NeuroMessage.trace()`, `enrichContext()` et `setType()` mutaient
`msg.neuro` en place. Comme `mcp-router` et `mcp-adapter` dupliquent
un message vers plusieurs sorties par simple `{...msg}` (spread
superficiel), toutes les branches partageaient la même référence
`neuro.trace` : deux branches parallèles (ex. deux tool calls simultanés,
`redclaw-diverge`) auraient vu leurs traces se mélanger de façon non
déterministe. Passage en copy-on-write dans les trois méthodes — chaque
appel détache sa propre copie, indépendamment de la discipline de
clonage du nœud en amont. Testé : deux branches issues du même message
source produisent bien deux chemins de trace distincts et la source
reste inchangée.

---

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

## [2.5.0] — Câblage explicite, suppression de toute influence fantôme

### Changement architectural majeur

Audit complet : aucune décision d'un agent ne doit dépendre d'un nœud
sans fil visible reliant ce nœud au chemin emprunté par le message.
Même un réflexe biologique repose sur une vraie synapse — court, mais réel.

### Corrigé

- `redclaw-orchestrator` appelait directement `goalStore.buildGoalContext()`
  et `skillTrust.buildTrustContext()`/`.record()` en interne, par simple
  correspondance de nom de skill — sans qu'aucun fil ne le montre dans le canvas.
  Toute influence passe désormais EXCLUSIVEMENT par des champs `msg.xxx_context`
  écrits par des nœuds explicitement câblés en amont.

### Nouveau

- `neuro-trust` mode **"record"** — tap passthrough à câbler sur le retour
  physique `[mcp-router] ⚡ → [neuro-trust:record] → [orchestrateur] entrée`.
  Relaie toujours le message inchangé ; alerte optionnelle en Output 2.
- `redclaw-goal` écrit désormais `msg.goal_context` sur sa sortie —
  câblable directement avant un skill sans passer par `neuro-context`.
- `agent-orchestrator` stamp `redclaw_call_started_at` à l'aller d'un tool call,
  permettant à `neuro-trust:record` de calculer la durée sans accès interne.

### Audit

- `policyEngine`, `skillRegistry`, `ticketStore`, `instrumentation` :
  vérifiés propres — actifs uniquement via un nœud physiquement câblé dans
  le chemin, ou journalisation passive (n'influence aucune décision).
