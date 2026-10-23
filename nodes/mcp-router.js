/**
 * RedClaw — MCP Router (v3)
 *
 * Sorties :
 *   1..N  → une par tool (comme avant) + msg.routeur injecté
 *   N+1   → ⚡ Retour Orchestrateur
 *
 * msg.routeur sur chaque sortie tool :
 *   { tool, params, callId }
 *
 * Retour depuis un adapter :
 *   msg.adaptateur = résultat
 *   msg.redclaw_call_id = callId original
 */

const NeuroMessage = require("../lib/neuro-message");
const { parseFiniteInteger, timerDelayOrDefault } = require("../lib/numeric");
const actionAuthority = require("../lib/action-authority");
const { randomUUID } = require("node:crypto");
const { types } = require("node:util");

function readAdapterResponse(adapter) {
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) {
    return { error: "adapter result must be an object" };
  }
  if (types.isProxy(adapter)) return { error: "adapter result must not be a Proxy" };

  const descriptors = Object.getOwnPropertyDescriptors(adapter);
  const callIdDescriptor = descriptors.callId;
  if (!callIdDescriptor || !callIdDescriptor.enumerable ||
      !Object.hasOwn(callIdDescriptor, "value") ||
      typeof callIdDescriptor.value !== "string" || !callIdDescriptor.value) {
    return { error: "adapter result must have an own data callId" };
  }

  const result = {};
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (key === "callId" || !descriptor.enumerable) continue;
    if (!Object.hasOwn(descriptor, "value")) {
      return { error: "adapter result must not contain accessors" };
    }
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { callId: callIdDescriptor.value, result };
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

function readConfiguredTools(config, node) {
  let toolsProperty;
  try {
    toolsProperty = readOwnDataProperty(config, "tools");
  } catch (_) {
    node.warn("[MCP Router] Configuration tools illisible; aucune sortie tool ne sera activée.");
    return [];
  }
  if (!toolsProperty.valid) {
    node.warn("[MCP Router] Configuration tools invalide; une propriété de données propre est requise.");
    return [];
  }
  if (toolsProperty.value === undefined || toolsProperty.value === null) return [];
  if (!Array.isArray(toolsProperty.value)) {
    node.warn("[MCP Router] Configuration tools invalide; un tableau est requis.");
    return [];
  }

  const tools = [];
  for (let index = 0; index < toolsProperty.value.length; index++) {
    try {
      const entryProperty = readOwnDataProperty(toolsProperty.value, String(index));
      const entry = entryProperty.value;
      const nameProperty = entry && typeof entry === "object" && !Array.isArray(entry)
        ? readOwnDataProperty(entry, "name")
        : { present: false, valid: false };
      const name = nameProperty.value;
      if (!entryProperty.valid || !entryProperty.present ||
          !nameProperty.valid || !nameProperty.present ||
          typeof name !== "string" || !name.trim()) {
        tools.push({ name: "" });
        node.warn(`[MCP Router] Configuration invalide pour le tool à la sortie ${index + 1}; entrée ignorée.`);
        continue;
      }
      tools.push({ name: name.trim() });
    } catch (_) {
      tools.push({ name: "" });
      node.warn(`[MCP Router] Configuration illisible pour le tool à la sortie ${index + 1}; entrée ignorée.`);
    }
  }
  return tools;
}

module.exports = function (RED) {
  function McpRouterNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    function readConfigValue(key) {
      if (!config || typeof config !== "object" || types.isProxy(config)) {
        node.warn("[MCP Router] Configuration must be a plain object; using defaults");
        return undefined;
      }
      const descriptor = Object.getOwnPropertyDescriptor(config, key);
      if (!descriptor) return undefined;
      if (!Object.hasOwn(descriptor, "value")) {
        node.warn(`[MCP Router] Configuration "${key}" must be a data property; using its default`);
        return undefined;
      }
      return descriptor.value;
    }
    function readConfigBoolean(key, fallback) {
      const value = readConfigValue(key);
      if (value === undefined) return fallback;
      if (typeof value !== "boolean") {
        node.warn(`[MCP Router] Configuration "${key}" must be a boolean; using its default`);
        return fallback;
      }
      return value;
    }

    node.tools   = readConfiguredTools(config, node);
    const configuredTimeout = readConfigValue("timeout");
    node.timeout = timerDelayOrDefault(configuredTimeout, 15000);
    const parsedTimeout = parseFiniteInteger(configuredTimeout);
    if (configuredTimeout !== undefined && configuredTimeout !== "" &&
        (parsedTimeout === null || parsedTimeout <= 0 || parsedTimeout > 2147483647)) {
      node.warn('[MCP Router] Configuration "timeout" must be a positive timer delay; using 15000');
    }
    node.debugMode = readConfigBoolean("debugMode", false);

    // Index nom → index de sortie
    node._idx   = new Map();
    node._duplicateTools = new Set();
    node.tools.forEach((tool, index) => {
      if (!tool.name) return;
      if (node._idx.has(tool.name)) node._duplicateTools.add(tool.name);
      node._idx.set(tool.name, index);
    });
    for (const toolName of node._duplicateTools) {
      node.warn(`[MCP Router] Configuration ambiguë : le tool "${toolName}" est déclaré plusieurs fois.`);
    }

    // N tools + 1 retour orchestrateur
    node._total  = node.tools.length + 1;
    node._retour = node.tools.length;

    // Appels en attente : identifiant interne → { resolve, reject, timer }
    node._pending = new Map();
    node._pendingExternalCallIds = new Set();
    node._closing = false;

    node.status({
      fill:  "green",
      shape: "dot",
      text:  node.tools.map(t => t.name).filter(Boolean).join(", ") || "Aucun tool",
    });

    node.on("input", async function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };
      if (node._closing) {
        done();
        return;
      }
      try {
        if (types.isProxy(msg)) {
          node.error("[MCP Router] Message Proxy refusé avant inspection.");
          done();
          return;
        }
        if (hasEnumerableAccessor(msg)) {
          node.error("[MCP Router] Données de requête invalides : les propriétés racine ne doivent pas être des accesseurs.");
          done();
          return;
        }
        const neuroProperty = readOwnDataProperty(msg, "neuro");
        if (!neuroProperty.valid) {
          node.error("[MCP Router] Propriété neuro invalide; Proxy refusé.");
          done();
          return;
        }
        if (types.isProxy(neuroProperty.value)) {
          node.error("[MCP Router] Métadonnées neuro Proxy refusées avant traçage.");
          done();
          return;
        }
        if (NeuroMessage.canTrace(neuroProperty.value)) {
          NeuroMessage.trace(msg, "mcp-router", "received");
        }
      } catch (error) {
        node.error(`[MCP Router] Message illisible : ${error.message}`);
        done();
        return;
      }

      let adapterProperty;
      try {
        adapterProperty = readOwnDataProperty(msg, "adaptateur");
      } catch (_) {
        node.warn("[MCP Router] Propriété adaptateur invalide ignorée");
        done();
        return;
      }
      if (!adapterProperty.valid) {
        node.warn("[MCP Router] Propriété adaptateur invalide ignorée : propriété de données propre requise");
        done();
        return;
      }

      // ── CAS 1 : retour d'un adapter (msg.adaptateur présent) ─────────────
      if (adapterProperty.present && adapterProperty.value !== undefined) {
        let response;
        try {
          response = readAdapterResponse(adapterProperty.value);
        } catch (_) {
          node.warn("[MCP Router] Réponse adapter invalide ignorée");
          done();
          return;
        }
        if (response.error) {
          node.warn(`[MCP Router] Réponse adapter invalide ignorée : ${response.error}`);
          done();
          return;
        }

        const { callId, result } = response;
        const p = callId && node._pending.get(callId);

        if (typeof callId === "string" && callId && p) {
          clearTimeout(p.timer);
          node._pending.delete(callId);
          node._pendingExternalCallIds.delete(p.externalCallId);
          p.resolve(result);
        } else {
          if (node.debugMode) node.warn(`[MCP Router] Résultat reçu mais callId inconnu ou expiré : ${callId}`);
        }
        done();
        return;
      }

      // ── CAS 2 : appel depuis l'orchestrateur (msg.redclaw.tool) ──────────
      let inputFields;
      try {
        const redclawProperty = readOwnDataProperty(msg, "redclaw");
        const callIdProperty = readOwnDataProperty(msg, "redclaw_call_id");
        const authorizationProperty = readOwnDataProperty(msg, "redclaw_authorization");
        const sessionProperty = readOwnDataProperty(msg, "sessionId");
        const redclaw = redclawProperty.value;
        const toolProperty = redclaw && typeof redclaw === "object"
          ? readOwnDataProperty(redclaw, "tool")
          : { present: false, valid: false };
        const paramsProperty = redclaw && typeof redclaw === "object"
          ? readOwnDataProperty(redclaw, "params")
          : { present: false, valid: false };
        inputFields = {
          redclaw,
          toolName: toolProperty.value,
          params: paramsProperty.value,
          externalCallId: callIdProperty.value,
          authorization: authorizationProperty.value,
          sessionId: sessionProperty.value,
          valid: redclawProperty.valid && callIdProperty.valid &&
            authorizationProperty.valid && sessionProperty.valid &&
            toolProperty.valid && paramsProperty.valid,
          redclawPresent: redclawProperty.present,
          callIdPresent: callIdProperty.present,
          toolPresent: toolProperty.present,
          paramsPresent: paramsProperty.present,
        };
      } catch (_) {
        node.error("[MCP Router] Données de requête invalides");
        done();
        return;
      }
      const {
        toolName, params, externalCallId, authorization: authorizationToken, sessionId: inputSessionId,
      } = inputFields;

      if (!inputFields.valid) {
        node.error("[MCP Router] Données de requête invalides; propriétés de données propres requises");
        done();
        return;
      }
      if (!inputFields.redclawPresent || !inputFields.callIdPresent ||
          !inputFields.toolPresent || !inputFields.paramsPresent ||
          !toolName || typeof externalCallId !== "string" || !externalCallId) {
        if (node.debugMode) node.warn("[MCP Router] msg.redclaw.tool ou redclaw_call_id manquant");
        done(); return;
      }

      const sessionId = inputSessionId === undefined ? "default" : inputSessionId;
      const authorization = actionAuthority.consumePermit(
        authorizationToken, toolName, params, sessionId,
      );
      if (!authorization.allowed) {
        const out = new Array(node._total).fill(null);
        out[node._retour] = {
          ...msg,
          payload: authorization.reason,
          redclaw_error: authorization.reason,
          redclaw_security: {
            blocked: true,
            tool: typeof toolName === "string" ? toolName : "invalid",
            reason: "Missing, expired, replayed, or mismatched action authorization",
          },
        };
        node.warn(`[MCP Router] Action refusée — ${authorization.reason}`);
        send(out); done(); return;
      }

      if (node._pendingExternalCallIds.has(externalCallId)) {
        const reason = `Duplicate in-flight callId: "${externalCallId}"`;
        const out = new Array(node._total).fill(null);
        out[node._retour] = {
          ...msg,
          payload: reason,
          redclaw_error: reason,
          redclaw_security: {
            blocked: true,
            tool: toolName,
            reason: "Call ID is already in flight",
          },
        };
        node.warn(`[MCP Router] Action refusée — ${reason}`);
        send(out); done(); return;
      }

      if (node._duplicateTools.has(toolName)) {
        const reason = `Tool ambigu : "${toolName}" est déclaré plusieurs fois dans le MCP Router`;
        const out = new Array(node._total).fill(null);
        out[node._retour] = {
          ...msg,
          payload: reason,
          redclaw_error: reason,
        };
        send(out);
        done();
        return;
      }

      const toolIdx = node._idx.get(toolName);
      if (toolIdx === undefined) {
        if (node.debugMode) node.warn(`[MCP Router] Tool inconnu : "${toolName}". Configurés : ${node.tools.map(t=>t.name).join(", ")}`);
        const out = new Array(node._total).fill(null);
        out[node._retour] = { ...msg, payload: `Tool inconnu : "${toolName}"`, redclaw_error: `Tool inconnu : "${toolName}"` };
        send(out); done(); return;
      }

      node.status({ fill: "blue", shape: "dot", text: `→ ${toolName}` });
      const internalCallId = randomUUID();
      let dispatchAuthorization;
      try {
        dispatchAuthorization = actionAuthority.issuePermit({
          tool: toolName,
          params,
          sessionId,
          kind: "dispatch",
          correlationId: internalCallId,
        });
      } catch (error) {
        const reason = `Dispatch authorization unavailable: ${error.message}`;
        const out = new Array(node._total).fill(null);
        out[node._retour] = {
          ...msg,
          payload: reason,
          redclaw_error: reason,
          redclaw_security: { blocked: true, tool: toolName, reason: "Dispatch authorization unavailable" },
        };
        node.warn(`[MCP Router] Action refusée — ${reason}`);
        send(out); done(); return;
      }
      if (node.debugMode) node.warn(`[MCP Router] → tool "${toolName}" callId:${internalCallId}`);

      try {
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            node._pending.delete(internalCallId);
            node._pendingExternalCallIds.delete(externalCallId);
            actionAuthority.revokePermit(dispatchAuthorization);
            reject(new Error(`Timeout "${toolName}" (${node.timeout}ms)`));
          }, node.timeout);

          node._pending.set(internalCallId, {
            resolve,
            reject,
            timer,
            dispatchAuthorization,
            externalCallId,
          });
          node._pendingExternalCallIds.add(externalCallId);

          // Route vers la sortie du tool avec msg.routeur injecté
          const out = new Array(node._total).fill(null);
          out[toolIdx] = {
            ...msg,
            redclaw_call_id: internalCallId,
            redclaw_dispatch_authorization: dispatchAuthorization,
            routeur: {
              tool:   toolName,
              params: params || {},
              callId: internalCallId,
            },
          };
          try {
            send(out);
          } catch (error) {
            clearTimeout(timer);
            node._pending.delete(internalCallId);
            node._pendingExternalCallIds.delete(externalCallId);
            actionAuthority.revokePermit(dispatchAuthorization);
            reject(error);
          }
        });

        if (node._closing) {
          done();
          return;
        }
        node.status({ fill: "green", shape: "dot", text: `✓ ${toolName}` });
        if (node.debugMode) node.warn(`[MCP Router] ✓ "${toolName}" résultat:${JSON.stringify(result)}`);

        // ⚡ Retour orchestrateur
        const out = new Array(node._total).fill(null);
        out[node._retour] = {
          ...msg,
          payload:         result,
          redclaw_call_id: externalCallId,
        };
        send(out);

      } catch (e) {
        if (node._closing) {
          done();
          return;
        }
        node.status({ fill: "red", shape: "ring", text: e.message.slice(0, 40) });
        node.error(`[MCP Router] ${e.message}`, msg);
        const out = new Array(node._total).fill(null);
        out[node._retour] = {
          ...msg,
          payload: e.message,
          redclaw_call_id: externalCallId,
          redclaw_error: e.message,
        };
        send(out);
      }

      done();
    });

    node.on("close", function () {
      node._closing = true;
      for (const [, p] of node._pending) {
        clearTimeout(p.timer);
        actionAuthority.revokePermit(p.dispatchAuthorization);
        p.reject(new Error("Nœud fermé"));
      }
      node._pending.clear();
      node._pendingExternalCallIds.clear();
      node.status({});
    });
  }

  RED.nodes.registerType("mcp-router", McpRouterNode);
};
