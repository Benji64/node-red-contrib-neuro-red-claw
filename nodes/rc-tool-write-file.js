/**
 * RedClaw Coding — Write File
 * Nœud autonome. Crée ou remplace un fichier.
 *
 * msg.payload = { path, content, encoding? }
 */
const fs   = require("fs");
const path = require("path");
const os   = require("os");

module.exports = function (RED) {
  function RcToolWriteFileNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.workDir = config.workDir || os.homedir();
    node.status({ fill: "green", shape: "dot", text: "Prêt" });

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      const callId = msg.redclaw_call_id;
      const params = msg.payload || {};

      if (!callId) { node.warn("[rc-tool-write-file] Pas de redclaw_call_id"); done(); return; }
      if (!params.path)    { send([{ ...msg, payload: "Paramètre 'path' manquant",    redclaw_error: "Paramètre 'path' manquant"    }]); done(); return; }
      if (params.content === undefined) { send([{ ...msg, payload: "Paramètre 'content' manquant", redclaw_error: "Paramètre 'content' manquant" }]); done(); return; }

      try {
        const filePath = path.resolve(node.workDir, params.path);
        if (!filePath.startsWith(path.resolve(node.workDir))) throw new Error(`Accès refusé hors de ${node.workDir}`);

        const existed = fs.existsSync(filePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, params.content, params.encoding || "utf8");

        const bytes = Buffer.byteLength(params.content, "utf8");
        node.status({ fill: "green", shape: "dot", text: `✓ ${path.basename(filePath)}` });
        send([{ ...msg, payload: { path: filePath, bytes, created: !existed, lines: params.content.split("\n").length } }]);
      } catch (e) {
        node.status({ fill: "red", shape: "ring", text: e.message.slice(0, 30) });
        send([{ ...msg, payload: e.message, redclaw_error: e.message }]);
      }
      done();
    });
    node.on("close", () => node.status({}));
  }
  RED.nodes.registerType("rc-tool-write-file", RcToolWriteFileNode);
};
