/**
 * neuro-red-claw v2.5 — Policy Config
 *
 * Config-node : jeu de règles PARTAGEABLE entre plusieurs nœuds redclaw-policy,
 * exactement comme llm-config est partagé entre plusieurs orchestrateurs.
 *
 * Ce n'est PAS un registre ambiant : le partage n'existe QUE si un nœud
 * redclaw-policy sélectionne explicitement ce config-node dans son propre
 * panneau de configuration (dropdown "Politiques partagées"). Rien ne
 * s'applique automatiquement par coïncidence de nom ou de scope.
 *
 * Usage typique : règles de sécurité valables pour toute la maison
 * ("jamais couper le chauffage si présence détectée"), définies une
 * seule fois ici, puis référencées par chaque nœud redclaw-policy
 * qui doit les respecter.
 */

module.exports = function (RED) {
  function RedclawPolicyConfigNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    try {
      node.policies = config.policies?.trim() ? JSON.parse(config.policies) : [];
    } catch (e) {
      node.policies = [];
      node.warn(`[redclaw-policy-config] JSON invalide : ${e.message}`);
    }

    node.label = () => node.name || `${node.policies.length} politique(s) partagée(s)`;
  }

  RED.nodes.registerType("redclaw-policy-config", RedclawPolicyConfigNode);

  // Liste les policy-config déployés — ressources nommées et référençables,
  // pas un état d'exécution ambiant (analogue à lister les llm-config disponibles).
  RED.httpAdmin.get("/redclaw/policy-configs",
    RED.auth.needsPermission("flows.read"),
    (req, res) => {
      const configs = [];
      RED.nodes.eachNode(n => {
        if (n.type === "redclaw-policy-config") {
          const runtimeNode = RED.nodes.getNode(n.id);
          configs.push({
            id: n.id,
            name: n.name || n.id,
            policyCount: runtimeNode?.policies?.length ?? 0,
          });
        }
      });
      res.json({ configs });
    }
  );

  // Contenu d'UNE ressource nommée précise — pas une vue globale.
  // Sert uniquement à prévisualiser ce qu'un nœud redclaw-policy référence
  // explicitement, depuis son propre panneau de configuration.
  RED.httpAdmin.get("/redclaw/policy-configs/:id",
    RED.auth.needsPermission("flows.read"),
    (req, res) => {
      const runtimeNode = RED.nodes.getNode(req.params.id);
      if (!runtimeNode || runtimeNode.type !== "redclaw-policy-config") {
        return res.status(404).json({ error: "policy-config introuvable" });
      }
      res.json({ id: req.params.id, name: runtimeNode.name, policies: runtimeNode.policies });
    }
  );
};
