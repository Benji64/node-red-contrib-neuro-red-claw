/**
 * RedClaw Coding — Git
 * Nœud autonome. Opérations git dans un dépôt.
 *
 * msg.payload = { operation, args?, message?, files?, limit? }
 */
const { execSync } = require("child_process");
const os           = require("os");

module.exports = function (RED) {
  function RcToolGitNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.workDir = config.workDir || os.homedir();
    node.timeout = parseInt(config.timeout, 10) || 30000;
    node.status({ fill: "green", shape: "dot", text: node.workDir });

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      const callId = msg.redclaw_call_id;
      const params = msg.payload || {};
      const op     = params.operation || "status";

      if (!callId) { node.warn("[rc-tool-git] Pas de redclaw_call_id"); done(); return; }

      const SUPPORTED = new Set(["status","diff","log","show","branch","add","commit","checkout","pull","push","stash","reset"]);
      if (!SUPPORTED.has(op)) {
        send([{ ...msg, payload: `Opération non supportée : ${op}`, redclaw_error: `Opération non supportée : ${op}` }]);
        done(); return;
      }

      let cmd;
      try {
        switch (op) {
          case "status":   cmd = "git status --short"; break;
          case "diff":     cmd = `git diff ${params.args || ""}`.trim(); break;
          case "log":      cmd = `git log --oneline -${params.limit || 10}`; break;
          case "show":     cmd = `git show ${params.args || "HEAD"}`; break;
          case "branch":   cmd = "git branch -a"; break;
          case "add":      cmd = `git add ${params.files || "."}`.trim(); break;
          case "commit":
            if (!params.message) throw new Error("'message' requis pour git commit");
            cmd = `git commit -m "${params.message.replace(/"/g, '\\"')}"`;
            break;
          case "checkout":
            if (!params.args) throw new Error("'args' requis pour git checkout");
            cmd = `git checkout ${params.args}`;
            break;
          case "pull":     cmd = `git pull ${params.args || ""}`.trim(); break;
          case "push":     cmd = `git push ${params.args || ""}`.trim(); break;
          case "stash":    cmd = `git stash ${params.args || ""}`.trim(); break;
          case "reset":    cmd = `git reset ${params.args || "--soft HEAD~1"}`.trim(); break;
        }

        node.status({ fill: "blue", shape: "dot", text: `git ${op}` });

        const stdout = execSync(cmd, { cwd: node.workDir, encoding: "utf8", timeout: node.timeout });
        node.status({ fill: "green", shape: "dot", text: `✓ git ${op}` });
        send([{ ...msg, payload: { operation: op, command: cmd, stdout, success: true } }]);

      } catch (e) {
        node.status({ fill: "red", shape: "ring", text: e.message.slice(0, 30) });
        send([{ ...msg, payload: { operation: op, stdout: e.stdout || "", stderr: e.stderr || e.message, success: false }, redclaw_error: e.stderr || e.message }]);
      }
      done();
    });
    node.on("close", () => node.status({}));
  }
  RED.nodes.registerType("rc-tool-git", RcToolGitNode);
};
