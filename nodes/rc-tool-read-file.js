/**
 * RedClaw Coding — Read File
 * Nœud autonome. Lit le contenu d'un fichier.
 *
 * msg.payload = { path, start_line?, end_line?, encoding? }
 */
const fs   = require("fs");
const path = require("path");
const os   = require("os");

module.exports = function (RED) {
  function RcToolReadFileNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.workDir = config.workDir || os.homedir();
    node.status({ fill: "green", shape: "dot", text: "Prêt" });

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      const callId = msg.redclaw_call_id;
      const params = msg.payload || {};

      if (!callId) { node.warn("[rc-tool-read-file] Pas de redclaw_call_id"); done(); return; }
      if (!params.path) {
        send([{ ...msg, payload: "Paramètre 'path' manquant", redclaw_error: "Paramètre 'path' manquant" }]);
        done(); return;
      }

      try {
        const filePath = path.resolve(node.workDir, params.path);

        // Sécurité : reste dans workDir
        if (!filePath.startsWith(path.resolve(node.workDir))) {
          throw new Error(`Accès refusé hors de ${node.workDir}`);
        }
        if (!fs.existsSync(filePath)) throw new Error(`Fichier introuvable : ${filePath}`);

        let content = fs.readFileSync(filePath, params.encoding || "utf8");
        let lines   = content.split("\n");

        if (params.start_line || params.end_line) {
          const s = Math.max(0, (params.start_line || 1) - 1);
          const e = params.end_line || lines.length;
          lines   = lines.slice(s, e);
          content = lines.join("\n");
        }

        node.status({ fill: "green", shape: "dot", text: `✓ ${path.basename(filePath)}` });
        send([{ ...msg, payload: { path: filePath, content, lines: lines.length, size: fs.statSync(filePath).size } }]);
      } catch (e) {
        node.status({ fill: "red", shape: "ring", text: e.message.slice(0, 30) });
        send([{ ...msg, payload: e.message, redclaw_error: e.message }]);
      }
      done();
    });
    node.on("close", () => node.status({}));
  }
  RED.nodes.registerType("rc-tool-read-file", RcToolReadFileNode);
};
