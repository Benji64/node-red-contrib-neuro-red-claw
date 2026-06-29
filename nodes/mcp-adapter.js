/**
 * RedClaw — MCP Adapter (v4)
 *
 * inputTransform  : msg.payload = params LLM, msg.routeur accessible,
 *                   msg.adaptateur pré-initialisé avec callId
 *                   Mode simple (checkbox) si pas de code
 *
 * outputTransform : msg.payload = résultat nœud Node-RED
 *                   Doit définir msg.adaptateur = { ... }
 *                   callId injecté automatiquement dans msg.adaptateur
 *
 * MCP Router vérifie msg.adaptateur.callId avant de continuer
 */

module.exports = function (RED) {
  function McpAdapterNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.toolName    = (config.toolName    || "").trim();
    node.timeout     = parseInt(config.timeout, 10) || 15000;
    node.simpleMode  = config.simpleMode  === true;
    node.debugMode   = config.debugMode   === true; // checkbox mode simple entrée

    node._inputFn    = _compile(config.inputTransform,   "inputTransform",   node);
    node._outputFn   = _compile(config.outputTransform,  "outputTransform",  node);
    node._validateFn = _compile(config.validateResponse, "validateResponse", node);

    node.status({
      fill:  node.toolName ? "green" : "yellow",
      shape: "dot",
      text:  node.toolName || "toolName manquant",
    });

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      // ── CAS 1 : retour du nœud Node-RED (pas de msg.routeur) ─────────────
      if (!msg.routeur) {
        const callId = msg.redclaw_call_id;

        // Ignore les messages sans callId (mises à jour périodiques, status spontanés…)
        if (!callId) {
          if (node.debugMode) node.warn(`[mcp-adapter:${node.toolName}] message ignoré — pas de redclaw_call_id (mise à jour spontanée ?)`);
          done();
          return;
        }

        // ── Validation de la réponse ─────────────────────────────────────────
        // Si validateResponse est défini, vérifie que ce msg est bien la réponse attendue
        // et pas un update périodique du nœud (ex: hub Tuya qui envoie toutes les 2s)
        if (node._validateFn) {
          let isValid = false;
          try {
            isValid = node._validateFn({ ...msg }, node);
          } catch (_) {}

          if (!isValid) {
            if (node.debugMode) {
              node.warn(`[mcp-adapter:${node.toolName}] [corrélation] message ignoré — pas la réponse attendue (callId: ${callId})`);
            }
            // Laisse la Promise ouverte — attend la vraie réponse
            done();
            return;
          }
        }

        // Réinitialise msg.adaptateur avec callId avant le transform sortie
        const outMsg = {
          ...msg,
          adaptateur: { callId },  // toujours disponible dans outputTransform
        };

        // Prépare la variable "adaptateur" accessible dans le code outputTransform
        // L'utilisateur écrit : adaptateur.success = true; adaptateur.state = "ON";
        const adaptateur = {};

        // Applique outputTransform avec adaptateur comme variable locale
        if (node._outputFn) {
          node._outputFn(outMsg, node, adaptateur);
        }

        // Si adaptateur est vide (rien n'a été défini) → fallback sur payload brut
        if (Object.keys(adaptateur).length === 0) {
          if (node._outputFn) {
            node.warn(`[mcp-adapter:${node.toolName}] outputTransform n'a rien mis dans adaptateur — utilise msg.payload brut`);
          }
          adaptateur.success = true;
          adaptateur.result  = msg.payload;
        }

        // Fusionne adaptateur + callId dans msg.adaptateur
        // callId toujours injecté par le système — ne peut pas être perdu
        outMsg.adaptateur = { ...adaptateur, callId };

        if (node.debugMode) node.warn(`[mcp-adapter:${node.toolName}] sortie → adaptateur:${JSON.stringify(outMsg.adaptateur)}`);

        node.status({ fill: "green", shape: "dot", text: `✓ ${node.toolName}` });

        // Output 2 → MCP Router
        send([null, outMsg]);
        done();
        return;
      }

      // ── CAS 2 : appel depuis le MCP Router ───────────────────────────────
      const { tool, params, callId } = msg.routeur;
      node.status({ fill: "blue", shape: "dot", text: `→ ${tool}` });
      if (node.debugMode) node.warn(`[mcp-adapter:${node.toolName}] entrée ← params:${JSON.stringify(params)} callId:${callId}`);

      // Pré-initialise msg.adaptateur avec callId — lisible dans inputTransform
      let outMsg = {
        ...msg,
        payload:         params || {},
        redclaw_call_id: callId,
        // msg.routeur conservé → accessible dans inputTransform
        // msg.adaptateur pré-initialisé → lisible dans inputTransform
        adaptateur: { callId },
      };

      if (node._inputFn) {
        // Mode code : inputTransform défini par l'utilisateur
        outMsg = node._inputFn(outMsg) || outMsg;
      } else if (node.simpleMode) {
        // Mode simple (checkbox) : msg.payload passé tel quel
        // Rien à faire — msg.payload est déjà = params
      }

      // Nettoie routeur après le transform
      outMsg.routeur = undefined;

      // Output 1 → nœud Node-RED
      send([outMsg, null]);
      done();
    });

    node.on("close", () => node.status({}));
  }

  function _compile(code, label, node) {
    if (!code || !code.trim()) return null;
    try {
      if (label === "outputTransform") {
        // L'utilisateur enrichit la variable "adaptateur" disponible localement
        return new Function("msg", "node", "adaptateur", `
          try { ${code} }
          catch(e) { node.error('[mcp-adapter] outputTransform: ' + e.message); }
        `);
      } else if (label === "validateResponse") {
        // Doit retourner true (valide) ou false (ignorer)
        // msg.payload = résultat du nœud Node-RED
        return new Function("msg", "node", `
          try { ${code} }
          catch(e) { node.error('[mcp-adapter] validateResponse: ' + e.message); return true; }
        `);
      } else {
        // inputTransform : transforme msg avant envoi au nœud cible
        return new Function("msg", "node", `
          try { ${code} }
          catch(e) { node.error('[mcp-adapter] inputTransform: ' + e.message); return msg; }
        `);
      }
    } catch (e) {
      node.error(`[mcp-adapter] Compilation ${label} : ${e.message}`);
      return null;
    }
  }

  RED.nodes.registerType("mcp-adapter", McpAdapterNode);
};
