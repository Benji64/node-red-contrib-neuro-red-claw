/**
 * RedClaw Coding — Search Files
 * Nœud autonome. Recherche dans les fichiers par contenu ou par nom.
 *
 * msg.payload = { pattern, path?, type: "content"|"filename", file_pattern?, max_results? }
 */
const { execSync } = require("child_process");
const path         = require("path");
const os           = require("os");

module.exports = function (RED) {
  function RcToolSearchNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.workDir = config.workDir || os.homedir();
    node.timeout = parseInt(config.timeout, 10) || 15000;
    node.status({ fill: "green", shape: "dot", text: "Prêt" });

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      const callId = msg.redclaw_call_id;
      const params = msg.payload || {};

      if (!callId)        { node.warn("[rc-tool-search] Pas de redclaw_call_id"); done(); return; }
      if (!params.pattern){ send([{ ...msg, payload: "'pattern' manquant", redclaw_error: "'pattern' manquant" }]); done(); return; }

      const searchPath = params.path
        ? path.resolve(node.workDir, params.path)
        : node.workDir;
      const max  = params.max_results || 50;
      const type = params.type || "content";

      node.status({ fill: "blue", shape: "dot", text: `⌕ ${params.pattern.slice(0, 20)}` });

      try {
        let matches = [];

        if (type === "filename") {
          const out = execSync(
            `find "${searchPath}" -name "${params.pattern}" -not -path "*/node_modules/*" -not -path "*/.git/*" | head -${max}`,
            { encoding: "utf8", timeout: node.timeout }
          );
          matches = out.trim().split("\n").filter(Boolean).map(f => ({ file: f }));

        } else {
          const inc = params.file_pattern ? `--include="${params.file_pattern}"` : "";
          const files = execSync(
            `grep -rl ${inc} --exclude-dir=node_modules --exclude-dir=.git "${params.pattern}" "${searchPath}" 2>/dev/null | head -${max}`,
            { encoding: "utf8", timeout: node.timeout }
          ).trim().split("\n").filter(Boolean);

          for (const file of files.slice(0, 10)) {
            try {
              const lines = execSync(`grep -n "${params.pattern}" "${file}" | head -5`, { encoding: "utf8" })
                .trim().split("\n").filter(Boolean);
              lines.forEach(l => {
                const [lineNum, ...rest] = l.split(":");
                matches.push({ file, line: parseInt(lineNum), content: rest.join(":").trim() });
              });
            } catch (_) {}
          }
        }

        node.status({ fill: "green", shape: "dot", text: `✓ ${matches.length} résultat(s)` });
        send([{ ...msg, payload: { pattern: params.pattern, matches, count: matches.length } }]);
      } catch (e) {
        node.status({ fill: "red", shape: "ring", text: e.message.slice(0, 30) });
        send([{ ...msg, payload: e.message, redclaw_error: e.message }]);
      }
      done();
    });
    node.on("close", () => node.status({}));
  }
  RED.nodes.registerType("rc-tool-search", RcToolSearchNode);
};
