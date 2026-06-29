/**
 * RedClaw Coding — Coding Skill
 * Nœud autonome. Point d'entrée de l'agent de code.
 * N entrées (sources) / 1 sortie vers l'Orchestrateur.
 *
 * Configure le contexte du skill coding :
 *   - Répertoire de travail transmis à tous les rc-tool-*
 *   - Fichier REDCLAW.md (équivalent CLAUDE.md) injecté dans le system prompt
 *   - Liste des tools disponibles
 */
const fs   = require("fs");
const path = require("path");
const os   = require("os");

const TOOLS = ["bash", "read_file", "write_file", "edit_file", "search_files", "git", "list_dir"];

module.exports = function (RED) {
  function RcCodingSkillNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.workDir     = config.workDir     || os.homedir();
    node.contextFile = config.contextFile || "REDCLAW.md";

    node.status({ fill: "green", shape: "dot", text: `coding · ${path.basename(node.workDir)}` });

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      const userMessage = typeof msg.payload === "string"
        ? msg.payload.trim()
        : JSON.stringify(msg.payload);

      if (!userMessage) { done(); return; }

      // Charge le contexte projet REDCLAW.md
      let projectContext = "";
      try {
        const ctxPath = path.resolve(node.workDir, node.contextFile);
        if (fs.existsSync(ctxPath)) projectContext = fs.readFileSync(ctxPath, "utf8");
      } catch (_) {}

      msg.redclaw = {
        userMessage,
        skill: {
          name:        "coding",
          tools:       TOOLS.join(", "),
          mcpServer:   "",
          description: "Agent de code : lit, écrit, modifie des fichiers, exécute bash, gère git.",
          workDir:     node.workDir,
          systemContext: [
            projectContext ? `Contexte projet :\n${projectContext}` : "",
            `Répertoire de travail : ${node.workDir}`,
            `Tools : ${TOOLS.join(", ")}`,
            "Préfère edit_file pour modifier un fichier existant.",
            "Vérifie avec read_file ou list_dir avant d'écrire.",
            "Lance bash pour tester le résultat.",
          ].filter(Boolean).join("\n"),
        },
      };

      if (!msg.sessionId) msg.sessionId = "coding"; // 1 fichier JSON par skill coding

      send(msg);
      done();
    });

    node.on("close", () => node.status({}));
  }

  RED.nodes.registerType("rc-coding-skill", RcCodingSkillNode);
};
