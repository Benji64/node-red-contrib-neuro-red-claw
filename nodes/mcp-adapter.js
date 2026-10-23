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

const NeuroMessage = require("../lib/neuro-message");
const { parseFiniteInteger, timerDelayOrDefault } = require("../lib/numeric");
const actionAuthority = require("../lib/action-authority");
const { types } = require("node:util");

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function hasThenMethod(value) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return false;
  if (types.isProxy(value)) return false;
  let current = value;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "then");
    if (descriptor) {
      return !Object.hasOwn(descriptor, "value") || typeof descriptor.value === "function";
    }
    current = Object.getPrototypeOf(current);
  }
  return false;
}

function rejectAsyncResult(node, result, stage, msg) {
  if (types.isPromise(result)) {
    Promise.prototype.then.call(result, undefined, error => {
      const detail = error && typeof error.message === "string" ? error.message : String(error);
      node.error(`[mcp-adapter] ${stage} rejected: ${detail}`, msg);
    });
    return true;
  }
  return hasThenMethod(result);
}

function readOwnDataProperty(object, key) {
  if (types.isProxy(object)) return { present: true, valid: false };
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return { present: false, valid: true };
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
    return { present: true, valid: false };
  }
  return { present: true, valid: true, value: descriptor.value };
}

function hasEnumerableAccessor(object) {
  const descriptors = Object.getOwnPropertyDescriptors(object);
  return Reflect.ownKeys(descriptors).some(key => {
    const descriptor = descriptors[key];
    return descriptor.enumerable && !Object.hasOwn(descriptor, "value");
  });
}

function copyMessageDataProperties(object) {
  const copy = {};
  const descriptors = Object.getOwnPropertyDescriptors(object);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) continue;
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError("inputTransform message must not contain accessors");
    }
    Object.defineProperty(copy, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

function copyOwnEnumerableDataProperties(object) {
  const copy = {};
  const descriptors = Object.getOwnPropertyDescriptors(object);
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) continue;
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError("outputTransform adaptateur must not contain accessors");
    }
    Object.defineProperty(copy, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

module.exports = function (RED) {
  function McpAdapterNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node._configurationErrors = [];
    function readConfigValue(key) {
      if (!config || typeof config !== "object" || types.isProxy(config)) {
        const reason = "configuration must be a plain object";
        if (!node._configurationErrors.includes(reason)) node._configurationErrors.push(reason);
        return undefined;
      }
      const descriptor = Object.getOwnPropertyDescriptor(config, key);
      if (!descriptor) return undefined;
      if (!Object.hasOwn(descriptor, "value")) {
        const reason = `${key} must be a data property`;
        node._configurationErrors.push(reason);
        return undefined;
      }
      return descriptor.value;
    }
    function readConfigBoolean(key, fallback) {
      const value = readConfigValue(key);
      if (value === undefined) return fallback;
      if (typeof value !== "boolean") {
        node.warn(`[mcp-adapter] Configuration "${key}" must be a boolean; using its default`);
        return fallback;
      }
      return value;
    }

    const configuredToolName = readConfigValue("toolName");
    if (configuredToolName !== undefined && typeof configuredToolName !== "string") {
      node._configurationErrors.push("toolName must be a string");
      node.toolName = "";
    } else {
      node.toolName = (configuredToolName || "").trim();
    }
    const configuredTimeout = readConfigValue("timeout");
    node.timeout = timerDelayOrDefault(configuredTimeout, 15000);
    const parsedTimeout = parseFiniteInteger(configuredTimeout);
    if (configuredTimeout !== undefined && configuredTimeout !== "" &&
        (parsedTimeout === null || parsedTimeout <= 0 || parsedTimeout > 2147483647)) {
      node.warn('[mcp-adapter] Configuration "timeout" must be a positive timer delay; using 15000');
    }
    node.simpleMode = readConfigBoolean("simpleMode", false);
    node.debugMode = readConfigBoolean("debugMode", false);
    node._pending = new Map();
    node._closing = false;

    node._inputFn    = _compile(readConfigValue("inputTransform"),   "inputTransform",   node);
    node._outputFn   = _compile(readConfigValue("outputTransform"),  "outputTransform",  node);
    node._validateFn = _compile(readConfigValue("validateResponse"), "validateResponse", node);

    node.status({
      fill:  node._configurationErrors.length ? "red" : node.toolName ? "green" : "yellow",
      shape: node._configurationErrors.length ? "ring" : "dot",
      text:  node._configurationErrors.length
        ? "Configuration invalide"
        : node.toolName || "toolName manquant",
    });
    if (node._configurationErrors.length) {
      node.warn(`[mcp-adapter:${node.toolName || "unconfigured"}] Configuration invalide; les actions seront refusées.`);
    }

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };
      if (node._closing) {
        done();
        return;
      }
      try {
        if (types.isProxy(msg)) {
          node.error("[mcp-adapter] Message Proxy refusé avant inspection.");
          done();
          return;
        }
        if (hasEnumerableAccessor(msg)) {
          node.error("[mcp-adapter] Message refusé : les propriétés racine ne doivent pas être des accesseurs.");
          done();
          return;
        }
        const neuroProperty = readOwnDataProperty(msg, "neuro");
        if (!neuroProperty.valid) {
          node.error("[mcp-adapter] Propriété neuro invalide; Proxy refusé.");
          done();
          return;
        }
        if (types.isProxy(neuroProperty.value)) {
          node.error("[mcp-adapter] Métadonnées neuro Proxy refusées avant traçage.");
          done();
          return;
        }
        if (NeuroMessage.canTrace(neuroProperty.value)) {
          NeuroMessage.trace(msg, `adapter:${node.toolName}`, "received");
        }
      } catch (error) {
        node.error(`[mcp-adapter] Message illisible : ${error.message}`);
        done();
        return;
      }

      let routeurProperty;
      try {
        routeurProperty = readOwnDataProperty(msg, "routeur");
      } catch (error) {
        node.error(`[mcp-adapter] routeur invalide: ${error.message}`, msg);
        done();
        return;
      }
      if (!routeurProperty.valid) {
        node.error("[mcp-adapter] routeur doit être une propriété de données propre", msg);
        done();
        return;
      }

      // ── CAS 1 : retour du nœud Node-RED (pas de msg.routeur) ─────────────
      if (!routeurProperty.value) {
        let callId;
        try {
          const callIdProperty = readOwnDataProperty(msg, "redclaw_call_id");
          if (!callIdProperty.valid) {
            node.error("[mcp-adapter] redclaw_call_id doit être une propriété de données propre", msg);
            done();
            return;
          }
          callId = callIdProperty.value;
        } catch (error) {
          node.error(`[mcp-adapter] redclaw_call_id invalide: ${error.message}`, msg);
          done();
          return;
        }

        // Ignore les messages sans callId (mises à jour périodiques, status spontanés…)
        if (typeof callId !== "string" || !callId) {
          if (node.debugMode) node.warn(`[mcp-adapter:${node.toolName}] message ignoré — pas de redclaw_call_id (mise à jour spontanée ?)`);
          done();
          return;
        }
        if (!node._pending.has(callId)) {
          if (node.debugMode) {
            node.warn(`[mcp-adapter:${node.toolName}] message ignoré — callId inconnu ou expiré (${callId})`);
          }
          done();
          return;
        }

        // ── Validation de la réponse ─────────────────────────────────────────
        // Si validateResponse est défini, vérifie que ce msg est bien la réponse attendue
        // et pas un update périodique du nœud (ex: hub Tuya qui envoie toutes les 2s)
        if (node._validateFn) {
          let isValid;
          try {
            isValid = node._validateFn({ ...msg }, node);
            if (rejectAsyncResult(node, isValid, "validateResponse", msg)) {
              node.error("[mcp-adapter] validateResponse must be synchronous", msg);
              done();
              return;
            }
          } catch (error) {
            node.error(`[mcp-adapter] validateResponse: ${error.message}`, msg);
            done();
            return;
          }

          if (isValid !== true) {
            if (node.debugMode) {
              node.warn(`[mcp-adapter:${node.toolName}] [corrélation] message ignoré — pas la réponse attendue (callId: ${callId})`);
            }
            // Laisse la Promise ouverte — attend la vraie réponse
            done();
            return;
          }
        }

        if (node._closing) {
          done();
          return;
        }
        clearTimeout(node._pending.get(callId));
        node._pending.delete(callId);

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
          try {
            const result = node._outputFn(outMsg, node, adaptateur);
            if (rejectAsyncResult(node, result, "outputTransform", msg)) {
              throw new TypeError("outputTransform must be synchronous");
            }
          } catch (error) {
            _sendFailure(node, send, msg, callId, "outputTransform", error);
            done();
            return;
          }
        }

        if (node._closing) {
          done();
          return;
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
        try {
          outMsg.adaptateur = {
            ...copyOwnEnumerableDataProperties(adaptateur),
            callId,
          };
        } catch (error) {
          _sendFailure(node, send, msg, callId, "outputTransform", error);
          done();
          return;
        }
        outMsg.redclaw_call_id = callId;

        if (node.debugMode) node.warn(`[mcp-adapter:${node.toolName}] sortie → adaptateur:${JSON.stringify(outMsg.adaptateur)}`);

        node.status({ fill: "green", shape: "dot", text: `✓ ${node.toolName}` });

        // Output 2 → MCP Router
        send([null, outMsg]);
        done();
        return;
      }

      // ── CAS 2 : appel depuis le MCP Router ───────────────────────────────
      let dispatchFields;
      try {
        const toolProperty = readOwnDataProperty(routeurProperty.value, "tool");
        const paramsProperty = readOwnDataProperty(routeurProperty.value, "params");
        const callIdProperty = readOwnDataProperty(routeurProperty.value, "callId");
        const authorizationProperty = readOwnDataProperty(msg, "redclaw_dispatch_authorization");
        const sessionProperty = readOwnDataProperty(msg, "sessionId");
        dispatchFields = {
          tool: toolProperty.value,
          params: paramsProperty.value,
          callId: callIdProperty.value,
          authorization: authorizationProperty.value,
          sessionId: sessionProperty.present ? sessionProperty.value : "default",
          valid: toolProperty.valid && paramsProperty.valid && callIdProperty.valid &&
            authorizationProperty.valid && sessionProperty.valid &&
            toolProperty.present && paramsProperty.present && callIdProperty.present,
        };
      } catch (error) {
        node.error(`[mcp-adapter] données de dispatch invalides: ${error.message}`, msg);
        done();
        return;
      }
      const { tool, params, callId, authorization: dispatchToken, sessionId } = dispatchFields;
      if (!dispatchFields.valid) {
        node.error("[mcp-adapter] données de dispatch invalides; propriétés de données propres requises", msg);
        done();
        return;
      }
      const authorization = actionAuthority.consumePermit(
        dispatchToken,
        tool,
        params,
        sessionId,
        "dispatch",
        callId,
      );
      if (!authorization.allowed) {
        node.warn(`[mcp-adapter:${node.toolName || "unconfigured"}] Action refusée — ${authorization.reason}`);
        done(); return;
      }
      if (!node.toolName || node.toolName !== tool ||
          typeof callId !== "string" || !callId) {
        _sendFailure(
          node,
          send,
          msg,
          callId,
          "configuration",
          new Error("Adapter tool or callId does not match authorized dispatch"),
        );
        done();
        return;
      }
      if (node._configurationErrors.length) {
        _sendFailure(
          node,
          send,
          msg,
          callId,
          "configuration",
          new Error(node._configurationErrors.join("; ")),
        );
        done();
        return;
      }
      if (node._pending.has(callId)) {
        const reason = `Duplicate in-flight adapter callId: "${callId}"`;
        node.warn(`[mcp-adapter:${node.toolName}] Action refusée — ${reason}`);
        done();
        return;
      }
      node.status({ fill: "blue", shape: "dot", text: `→ ${tool}` });
      if (node.debugMode) node.warn(`[mcp-adapter:${node.toolName}] entrée ← params:${JSON.stringify(params)} callId:${callId}`);

      const authorizedParams = deepFreeze(cloneJson(params));
      // Pré-initialise msg.adaptateur avec callId — lisible dans inputTransform
      let outMsg = {
        ...msg,
        payload:         cloneJson(authorizedParams),
        redclaw_call_id: callId,
        routeur: { tool, params: authorizedParams, callId },
        // msg.routeur conservé → accessible dans inputTransform
        // msg.adaptateur pré-initialisé → lisible dans inputTransform
        adaptateur: { callId },
      };

      if (node._inputFn) {
        try {
          const transformedMsg = node._inputFn(outMsg, node);
          if (rejectAsyncResult(node, transformedMsg, "inputTransform", msg)) {
            throw new TypeError("inputTransform must be synchronous");
          }
          if (transformedMsg !== undefined && transformedMsg !== null) {
            if (typeof transformedMsg !== "object" || Array.isArray(transformedMsg)) {
              throw new TypeError("inputTransform must return a message object");
            }
            if (types.isProxy(transformedMsg)) {
              throw new TypeError("inputTransform must not return a Proxy message");
            }
            outMsg = copyMessageDataProperties(transformedMsg);
          }
        } catch (error) {
          _sendFailure(node, send, msg, callId, "inputTransform", error);
          done();
          return;
        }
      } else if (node.simpleMode) {
        // Mode simple (checkbox) : msg.payload passé tel quel
        // Rien à faire — msg.payload est déjà = params
      }

      // Les transformations ne peuvent pas remplacer les identifiants de corrélation.
      outMsg.redclaw_call_id = callId;
      outMsg.adaptateur = {
        ...(outMsg.adaptateur && typeof outMsg.adaptateur === "object" &&
          !Array.isArray(outMsg.adaptateur) ? outMsg.adaptateur : {}),
        callId,
      };
      outMsg.routeur = undefined;

      if (node._closing) {
        done();
        return;
      }
      const timeout = setTimeout(() => {
        if (!node._pending.delete(callId) || node._closing) return;
        _sendFailure(
          node,
          send,
          msg,
          callId,
          "timeout",
          new Error(`No target response within ${node.timeout}ms`),
        );
      }, node.timeout);
      node._pending.set(callId, timeout);
      try {
        // Output 1 → nœud Node-RED
        send([outMsg, null]);
      } catch (error) {
        clearTimeout(timeout);
        node._pending.delete(callId);
        done(error);
        return;
      }
      done();
    });

    node.on("close", () => {
      node._closing = true;
      for (const timeout of node._pending.values()) clearTimeout(timeout);
      node._pending.clear();
      node.status({});
    });
  }

  function _compile(code, label, node) {
    if (code === undefined || code === null || code === "") return null;
    if (typeof code !== "string") {
      const reason = `${label} must be a string`;
      node._configurationErrors.push(reason);
      node.error(`[mcp-adapter] ${reason}`);
      return null;
    }
    if (!code.trim()) return null;
    try {
      if (label === "outputTransform") {
        // L'utilisateur enrichit la variable "adaptateur" disponible localement
        return new Function("msg", "node", "adaptateur", code);
      } else if (label === "validateResponse") {
        // Doit retourner true (valide) ou false (ignorer)
        // msg.payload = résultat du nœud Node-RED
        return new Function("msg", "node", code);
      } else {
        // inputTransform : transforme msg avant envoi au nœud cible
        return new Function("msg", "node", code);
      }
    } catch (e) {
      const reason = `Compilation ${label} : ${e.message}`;
      node._configurationErrors.push(reason);
      node.error(`[mcp-adapter] ${reason}`);
      return null;
    }
  }

  function _sendFailure(node, send, msg, callId, stage, error) {
    const detail = error && typeof error.message === "string" ? error.message : String(error);
    const reason = stage === "configuration"
      ? `Invalid adapter configuration: ${detail}`
      : `mcp-adapter ${stage} failed: ${detail}`;
    node.status({ fill: "red", shape: "ring", text: reason.slice(0, 40) });
    node.error(reason, msg);
    send([null, {
      ...msg,
      adaptateur: { callId, success: false, error: reason },
      redclaw_error: reason,
    }]);
  }

  RED.nodes.registerType("mcp-adapter", McpAdapterNode);
};
