/**
 * RedClaw Coding — Edit File (str_replace)
 * Nœud autonome. Remplace une chaîne unique dans un fichier.
 * Identique au pattern str_replace de Claude Code.
 *
 * msg.payload = { path, old_str, new_str }
 */
const fs   = require("fs");
const path = require("path");
const os   = require("os");

module.exports = function (RED) {
  function RcToolEditFileNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.workDir = config.workDir || os.homedir();
    node.status({ fill: "green", shape: "dot", text: "Prêt" });

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      const callId = msg.redclaw_call_id;
      const params = msg.payload || {};

      if (!callId) { node.warn("[rc-tool-edit-file] Pas de redclaw_call_id"); done(); return; }
      if (!params.path)    { send([{ ...msg, payload: "'path' manquant",    redclaw_error: "'path' manquant"    }]); done(); return; }
      if (!params.old_str) { send([{ ...msg, payload: "'old_str' manquant", redclaw_error: "'old_str' manquant" }]); done(); return; }

      try {
        const filePath = path.resolve(node.workDir, params.path);
        if (!filePath.startsWith(path.resolve(node.workDir))) throw new Error(`Accès refusé hors de ${node.workDir}`);
        if (!fs.existsSync(filePath)) throw new Error(`Fichier introuvable : ${filePath}`);

        const original = fs.readFileSync(filePath, "utf8");
        const count    = original.split(params.old_str).length - 1;
        if (count === 0) throw new Error(`'old_str' introuvable dans ${path.basename(filePath)}`);
        if (count > 1)   throw new Error(`'old_str' apparaît ${count} fois — doit être unique`);

        const newStr  = params.new_str !== undefined ? params.new_str : "";
        fs.writeFileSync(filePath, original.replace(params.old_str, newStr), "utf8");

        node.status({ fill: "green", shape: "dot", text: `✓ ${path.basename(filePath)}` });
        send([{ ...msg, payload: { path: filePath, replaced: true } }]);
      } catch (e) {
        node.status({ fill: "red", shape: "ring", text: e.message.slice(0, 30) });
        send([{ ...msg, payload: e.message, redclaw_error: e.message }]);
      }
      done();
    });
    node.on("close", () => node.status({}));
  }
  RED.nodes.registerType("rc-tool-edit-file", RcToolEditFileNode);
};
