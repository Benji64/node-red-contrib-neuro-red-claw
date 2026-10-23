/**
 * neuro-red-claw — Envelope
 *
 * Standardise les messages dans le format neuro-red-claw.
 * Ajoute msg.neuro = { id, type, source, intent, context, data, priority, trace }
 * Trace automatiquement le chemin du message à chaque passage.
 *
 * ─── Modes ────────────────────────────────────────────────────────────────────
 *  "wrap"    : enveloppe msg.payload dans msg.neuro (entrée système)
 *  "unwrap"  : extrait msg.neuro.data vers msg.payload (sortie système)
 *  "trace"   : ajoute juste une étape de trace, passe le message
 *  "validate": vérifie que le message est bien formaté
 *
 * ─── Position dans le flow ────────────────────────────────────────────────────
 *  En entrée : [Source externe] ──► [neuro-envelope: wrap] ──► [redclaw-skill]
 *  En sortie : [redclaw-orchestrator] ──► [neuro-envelope: unwrap] ──► [Dashboard]
 *  Partout   : [nœud A] ──► [neuro-envelope: trace] ──► [nœud B]
 */

const NeuroMessage = require("../lib/neuro-message");
const { types } = require("node:util");

function readMessageProperty(msg, key) {
  if (!msg || typeof msg !== "object" || types.isProxy(msg)) {
    throw new TypeError("msg must be a plain data object");
  }
  const prototype = Object.getPrototypeOf(msg);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("msg must be a plain data object");
  }
  const descriptor = Object.getOwnPropertyDescriptor(msg, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value")) {
    throw new TypeError(`msg.${key} must be a data property`);
  }
  return descriptor.value;
}

function readOwnDataProperty(record, key) {
  if (!record || typeof record !== "object" || types.isProxy(record)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && Object.hasOwn(descriptor, "value")
    ? { found: true, value: descriptor.value }
    : null;
}

function writeOwnDataProperty(record, key, value) {
  if (!record || typeof record !== "object" || types.isProxy(record)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor) {
    if (Object.hasOwn(descriptor, "value")) {
      if (!descriptor.writable && !descriptor.configurable) return false;
      Object.defineProperty(record, key, { ...descriptor, value });
    } else {
      if (!descriptor.configurable) return false;
      Object.defineProperty(record, key, {
        value,
        enumerable: descriptor.enumerable,
        writable: true,
        configurable: true,
      });
    }
    return true;
  }
  if (!Object.isExtensible(record)) return false;
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return true;
}

function readWrappedPayload(msg) {
  const neuro = readOwnDataProperty(msg, "neuro");
  if (!neuro) return null;
  const data = readOwnDataProperty(neuro.value, "data");
  if (!data) return null;
  return readOwnDataProperty(data.value, "payload");
}

module.exports = function (RED) {
  function NeuroEnvelopeNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    function readConfigValue(key) {
      if (!config || typeof config !== "object" || types.isProxy(config)) {
        node.warn("[neuro-envelope] Configuration must be a plain object; using defaults");
        return undefined;
      }
      const descriptor = Object.getOwnPropertyDescriptor(config, key);
      if (!descriptor) return undefined;
      if (!Object.hasOwn(descriptor, "value")) {
        node.warn(`[neuro-envelope] Configuration "${key}" must be a data property; using its default`);
        return undefined;
      }
      return descriptor.value;
    }
    function readConfigString(key, fallback) {
      const value = readConfigValue(key);
      if (value === undefined) return fallback;
      if (typeof value !== "string") {
        node.warn(`[neuro-envelope] Configuration "${key}" must be a string; using its default`);
        return fallback;
      }
      return value;
    }
    function readConfigBoolean(key, fallback) {
      const value = readConfigValue(key);
      if (value === undefined) return fallback;
      if (typeof value !== "boolean") {
        node.warn(`[neuro-envelope] Configuration "${key}" must be a boolean; using its default`);
        return fallback;
      }
      return value;
    }

    const configuredMode = readConfigString("mode", "wrap").trim();
    const supportedModes = new Set(["wrap", "unwrap", "trace", "validate"]);
    if (configuredMode && !supportedModes.has(configuredMode)) {
      node.warn(`[neuro-envelope] Configuration "mode" is unsupported; using "wrap"`);
    }
    node.mode = supportedModes.has(configuredMode) ? configuredMode : "wrap";
    const configuredNodeName = readConfigString("nodeName", "");
    const nodeName = configuredNodeName.trim() || readConfigString("name", "envelope").trim();
    node.nodeName = nodeName || "envelope";
    node.msgType = readConfigString("msgType", "event") || "event";
    node.source = readConfigString("source", "").trim();
    node.intent = readConfigString("intent", "").trim();
    const configuredPriority = readConfigValue("priority");
    const priority = configuredPriority === undefined || configuredPriority === ""
      ? 50
      : typeof configuredPriority === "number"
        ? configuredPriority
        : typeof configuredPriority === "string" && /^\d+$/.test(configuredPriority.trim())
          ? Number(configuredPriority)
          : NaN;
    const validPriority = Number.isInteger(priority) && priority >= 0 && priority <= 100;
    if (!validPriority && configuredPriority !== undefined && configuredPriority !== "") {
      node.warn('[neuro-envelope] Configuration "priority" must be an integer between 0 and 100; using 50');
    }
    node.priority = validPriority ? priority : 50;
    node.strict = readConfigBoolean("strict", false);

    node.status({ fill:"green", shape:"dot",
      text:`${node.mode} · ${node.msgType}` });

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      switch (node.mode) {

        // ── Wrap : enveloppe dans le format standard ────────────────────
        case "wrap": {
          const payload = readMessageProperty(msg, "payload");
          const topic = readMessageProperty(msg, "topic");
          const priority = readMessageProperty(msg, "priority");
          const sessionId = readMessageProperty(msg, "sessionId");
          NeuroMessage.wrap(msg, {
            type:      node.msgType,
            source:    node.source || `node:${node.id.slice(0,8)}`,
            intent:    node.intent || (topic || ""),
            data:      { payload, topic },
            priority:  priority === undefined ? node.priority : priority,
            sessionId: sessionId === undefined ? "" : sessionId,
          });
          NeuroMessage.trace(msg, node.nodeName, "wrap");
          send([msg, null]);
          break;
        }

        // ── Unwrap : extrait les données du format standard ─────────────
        case "unwrap": {
          const wrappedPayload = readWrappedPayload(msg);
          if (wrappedPayload && wrappedPayload.found) {
            if (!writeOwnDataProperty(msg, "payload", wrappedPayload.value)) {
              node.error("[neuro-envelope] Impossible de remplacer msg.payload pendant unwrap", msg);
            }
          }
          NeuroMessage.trace(msg, node.nodeName, "unwrap");
          const summary = NeuroMessage.traceSummary(msg);
          node.status({ fill:"green", shape:"dot",
            text:`✓ ${NeuroMessage.traceLength(msg)} étapes` });
          if (node.strict) node.log(`[trace] ${summary}`);
          send([msg, null]);
          break;
        }

        // ── Trace : ajoute juste une étape ─────────────────────────────
        case "trace": {
          NeuroMessage.trace(msg, node.nodeName, node.intent || "pass");
          send([msg, null]);
          break;
        }

        // ── Validate : vérifie + route selon validité ───────────────────
        case "validate": {
          if (NeuroMessage.isValid(msg)) {
            NeuroMessage.trace(msg, node.nodeName, "validated");
            send([msg, null]);
          } else {
            node.warn(`[neuro-envelope] Message invalide — pas de msg.neuro`);
            send([null, msg]); // Output 2 : invalide
          }
          break;
        }

        default:
          node.warn(`[neuro-envelope] Mode inconnu : ${node.mode}`);
          send([msg, null]);
      }

      done();
    });

    node.on("close", () => node.status({}));
  }

  RED.nodes.registerType("neuro-envelope", NeuroEnvelopeNode);
};
