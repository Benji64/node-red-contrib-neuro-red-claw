/**
 * RedClaw Coding — Bash
 * Nœud autonome. Exécute une commande shell.
 * Reçoit depuis MCP Router, retourne le résultat au MCP Router.
 *
 * msg.payload = { command, cwd? }
 */
const { execSync } = require("child_process");
const path         = require("path");
const os           = require("os");

// Commandes toujours bloquées quel que soit le paramétrage
const BLOCKED = [/rm\s+-rf\s+\//, /mkfs/, /dd\s+if=/, /:\(\)\{.*\}/];

module.exports = function (RED) {
  function RcToolBashNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.workDir = config.workDir || os.homedir();
    node.timeout = parseInt(config.timeout, 10) || 30000;

    node.status({ fill: "green", shape: "dot", text: node.workDir });

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      const callId  = msg.redclaw_call_id;
      const params  = msg.payload || {};
      const command = params.command || params.cmd || "";

      if (!callId) {
        node.warn("[rc-tool-bash] Pas de redclaw_call_id — brancher sur un MCP Router");
        done(); return;
      }
      if (!command) {
        send([{ ...msg, payload: "Paramètre 'command' manquant", redclaw_error: "Paramètre 'command' manquant" }]);
        done(); return;
      }
      if (BLOCKED.some(r => r.test(command))) {
        send([{ ...msg, payload: `Commande bloquée : ${command}`, redclaw_error: `Commande bloquée : ${command}` }]);
        done(); return;
      }

      const cwd = params.cwd
        ? path.resolve(node.workDir, params.cwd)
        : node.workDir;

      node.status({ fill: "blue", shape: "dot", text: command.slice(0, 30) });

      try {
        const stdout = execSync(command, {
          cwd, timeout: node.timeout, encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
        });
        node.status({ fill: "green", shape: "dot", text: "✓" });
        send([{ ...msg, payload: { command, stdout, stderr: "", success: true, code: 0 } }]);
      } catch (e) {
        node.status({ fill: "red", shape: "ring", text: e.message.slice(0, 30) });
        send([{ ...msg,
          payload:       { command, stdout: e.stdout || "", stderr: e.stderr || e.message, success: false, code: e.status || 1 },
          redclaw_error: e.stderr || e.message,
        }]);
      }
      done();
    });

    node.on("close", () => node.status({}));
  }

  RED.nodes.registerType("rc-tool-bash", RcToolBashNode);
};
