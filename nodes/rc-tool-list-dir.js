/**
 * RedClaw Coding — List Directory
 * Nœud autonome. Liste le contenu d'un dossier.
 *
 * msg.payload = { path?, recursive?, max_depth? }
 */
const fs   = require("fs");
const path = require("path");
const os   = require("os");

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__"]);

module.exports = function (RED) {
  function RcToolListDirNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.workDir = config.workDir || os.homedir();
    node.status({ fill: "green", shape: "dot", text: "Prêt" });

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      const callId = msg.redclaw_call_id;
      const params = msg.payload || {};

      if (!callId) { node.warn("[rc-tool-list-dir] Pas de redclaw_call_id"); done(); return; }

      try {
        const dirPath  = params.path ? path.resolve(node.workDir, params.path) : node.workDir;
        const maxDepth = params.max_depth || 2;
        const entries  = [];

        function walk(dir, depth) {
          if (depth > maxDepth) return;
          for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            if (SKIP.has(item.name)) continue;
            const full = path.join(dir, item.name);
            const rel  = path.relative(dirPath, full);
            const stat = fs.statSync(full);
            entries.push({
              name:     rel,
              type:     item.isDirectory() ? "dir" : "file",
              size:     item.isDirectory() ? null : stat.size,
              modified: stat.mtime.toISOString(),
            });
            if (item.isDirectory() && params.recursive) walk(full, depth + 1);
          }
        }

        walk(dirPath, 0);
        node.status({ fill: "green", shape: "dot", text: `✓ ${entries.length} entrées` });
        send([{ ...msg, payload: { path: dirPath, entries, count: entries.length } }]);
      } catch (e) {
        node.status({ fill: "red", shape: "ring", text: e.message.slice(0, 30) });
        send([{ ...msg, payload: e.message, redclaw_error: e.message }]);
      }
      done();
    });
    node.on("close", () => node.status({}));
  }
  RED.nodes.registerType("rc-tool-list-dir", RcToolListDirNode);
};
