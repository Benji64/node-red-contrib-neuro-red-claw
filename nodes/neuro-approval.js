/**
 * neuro-red-claw — Approval UI
 *
 * File d'attente des actions à valider. Compatible Dashboard 2.0.
 * Connecté au security-gate Output 2 (actions RESTRICTED).
 *
 * ─── Entrées ──────────────────────────────────────────────────────────────────
 *  Depuis security-gate Output 2 (action à confirmer) :
 *    msg.redclaw.tool         = nom du tool
 *    msg.redclaw.params       = paramètres
 *    msg.redclaw_call_id      = identifiant de l'action en attente
 *    msg.redclaw_policy       = résultat de la politique
 *
 *  Depuis Dashboard 2.0 (bouton Approuver/Refuser) :
 *    msg.topic = "approve" | "reject"
 *    msg.payload = { actionId }
 *
 * ─── Sorties ──────────────────────────────────────────────────────────────────
 *  Output 1 → File d'attente formatée → ui-template Dashboard 2.0
 *  Output 2 → Action approuvée → MCP Router (continue le workflow)
 *  Output 3 → Action refusée → log / notification
 */

const { randomUUID } = require("crypto");
const { types } = require("node:util");
const {
  parseFiniteInteger,
  positiveIntegerOrDefault,
  timerDelayOrDefault,
} = require("../lib/numeric");
const actionAuthority = require("../lib/action-authority");

const AUTHENTICATED_REVIEWER = Symbol("neuro-approval-authenticated-reviewer");

function getAuthenticatedReviewer(req) {
  const user = req?.user;
  const reviewer = typeof user === "string" ? user : user?.username;
  return typeof reviewer === "string" && reviewer.trim() ? reviewer.trim() : null;
}

module.exports = function (RED) {
  function NeuroApprovalNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    function readConfigValue(key) {
      if (!config || typeof config !== "object" || types.isProxy(config)) {
        node.warn("[Approval] Configuration must be a plain object; using defaults");
        return undefined;
      }
      const descriptor = Object.getOwnPropertyDescriptor(config, key);
      if (!descriptor) return undefined;
      if (!Object.hasOwn(descriptor, "value")) {
        node.warn(`[Approval] Configuration "${key}" must be a data property; using its default`);
        return undefined;
      }
      return descriptor.value;
    }
    function readConfigBoolean(key, fallback) {
      const value = readConfigValue(key);
      if (value === undefined) return fallback;
      if (typeof value !== "boolean") {
        node.warn(`[Approval] Configuration "${key}" must be a boolean; using its default`);
        return fallback;
      }
      return value;
    }

    const configuredTimeout = readConfigValue("timeout");
    node.timeout = timerDelayOrDefault(configuredTimeout, 300000);
    const parsedTimeout = parseFiniteInteger(configuredTimeout);
    if (configuredTimeout !== undefined && configuredTimeout !== "" &&
        (parsedTimeout === null || parsedTimeout <= 0 || parsedTimeout > 2147483647)) {
      node.warn('[Approval] Configuration "timeout" must be a positive timer delay; using 300000');
    }
    const configuredMaxQueue = readConfigValue("maxQueue");
    node.maxQueue = positiveIntegerOrDefault(configuredMaxQueue, 20);
    if (configuredMaxQueue !== undefined && configuredMaxQueue !== "" &&
        (parseFiniteInteger(configuredMaxQueue) === null ||
          parseFiniteInteger(configuredMaxQueue) <= 0)) {
      node.warn('[Approval] Configuration "maxQueue" must be a positive integer; using 20');
    }
    node.autoReject = readConfigBoolean("autoReject", false);
    node.requireAuthenticatedReviewer = readConfigBoolean("requireAuthenticatedReviewer", false);

    // File d'attente : actionId → { id, tool, params, msg, ts, deadline, reason }
    node._queue   = new Map();
    node._history = []; // actions traitées

    _updateStatus();

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      // ── Décision depuis Dashboard (approve / reject) ──────────────────
      if (msg.topic === "approve" || msg.topic === "reject") {
        const authenticatedReviewer = msg[AUTHENTICATED_REVIEWER];
        if (node.requireAuthenticatedReviewer &&
            (typeof authenticatedReviewer !== "string" || !authenticatedReviewer.trim())) {
          node.warn("[Approval] Décision refusée : un réviseur authentifié est requis");
          done(); return;
        }
        const actionId = msg.payload?.actionId || msg.payload;
        const action   = node._queue.get(actionId);

        if (!action) {
          node.warn(`[Approval] Action "${actionId}" introuvable ou expirée`);
          done(); return;
        }

        clearTimeout(action._timer);
        node._queue.delete(actionId);

        // v2.17 — l'entrée d'historique est PUBLIQUE (jamais _timer ni
        // originalMsg : objets non sérialisables / internes), et le message
        // renvoyé est un CLONE PROFOND de la demande d'origine — ce qui
        // s'exécute après approbation est exactement ce qui a été mis en
        // file, quoi que fasse un nœud en aval du dashboard avec son msg.
        const humanDecidedAt = new Date().toISOString();
        const entry = _record(action, msg.topic, {
          decidedBy: authenticatedReviewer || msg.decidedBy || "dashboard",
          reviewerAuthenticated: typeof authenticatedReviewer === "string",
          human_required: true,
          human_decision: msg.topic === "approve" ? "approved" : "rejected",
          human_decided_at: humanDecidedAt,
          human_decided_by: authenticatedReviewer || null,
          approved_at: msg.topic === "approve" ? humanDecidedAt : null,
          approved_by: msg.topic === "approve" ? authenticatedReviewer : null,
        });

        _updateStatus();

        if (msg.topic === "approve") {
          const approvedMsg = _clone(action.originalMsg);
          const safety = approvedMsg.redclaw_safety;
          let authorization;
          if (safety?.approvalRequestId) {
            authorization = actionAuthority.approveRequest(
              safety.approvalRequestId,
              action.tool,
              action.params,
              approvedMsg.sessionId === undefined ? "default" : approvedMsg.sessionId,
            );
          } else if (typeof approvedMsg.redclaw_authorization === "string") {
            authorization = { allowed: true, token: approvedMsg.redclaw_authorization };
          } else {
            authorization = {
              allowed: false,
              reason: "Aucune autorisation de sécurité valide n'est liée à cette demande",
            };
          }
          if (!authorization.allowed) {
            actionAuthority.cancelApprovalRequest(safety?.approvalRequestId);
            const rejected = _record(action, "blocked", { reason: authorization.reason });
            node.warn(`[Approval] Action "${action.tool}" non exécutée — ${authorization.reason}`);
            send([_queueMsg(msg), null, {
              ..._clone(action.originalMsg),
              payload: authorization.reason,
              redclaw_approval: rejected,
              redclaw_security: {
                blocked: true,
                tool: action.tool,
                reason: "Missing or invalid safety authorization",
              },
            }]);
            _updateStatus();
            done(); return;
          }
          approvedMsg.redclaw_authorization = authorization.token;
          approvedMsg.redclaw_approval = entry;
          node.status({ fill:"green", shape:"dot", text:`✓ ${action.tool}` });
          // Renvoie seulement une demande liée à une autorisation de sécurité à usage unique.
          send([_queueMsg(msg), approvedMsg, null]);
        } else {
          actionAuthority.cancelApprovalRequest(action.originalMsg.redclaw_safety?.approvalRequestId);
          node.status({ fill:"red", shape:"ring", text:`✗ ${action.tool}` });
          // Basé sur la demande d'origine : redclaw_call_id & co survivent,
          // le demandeur peut corréler le refus à sa demande.
          send([_queueMsg(msg), null, {
            ..._clone(action.originalMsg),
            payload: `Refusé par opérateur : ${action.tool}`,
            redclaw_approval: entry,
          }]);
        }
        done(); return;
      }

      // ── Nouvelle action depuis security-gate ou redclaw-policy ────────
      if (msg.redclaw?.tool || msg.redclaw_policy) {
        const tool    = msg.redclaw?.tool || "action_inconnue";
        const params  = msg.redclaw?.params || {};
        const reason  = msg.redclaw_policy?.reason || msg.redclaw_security?.reason || "";
        const actionId = randomUUID();

        // Expire automatiquement si timeout
        const _timer = setTimeout(() => {
          const action = node._queue.get(actionId);
          if (!action) return;
          node._queue.delete(actionId);
          actionAuthority.cancelApprovalRequest(action.originalMsg.redclaw_safety?.approvalRequestId);
          const entry = _record(action, "timeout");

          if (node.autoReject) {
            send([_queueMsg(msg), null, {
              ..._clone(action.originalMsg),
              payload: `Timeout : ${tool} (${node.timeout/1000}s sans décision)`,
              redclaw_approval: entry,
            }]);
          }
          _updateStatus();
          node.warn(`[Approval] Action "${tool}" expirée après ${node.timeout/1000}s`);
        }, node.timeout);

        node._queue.set(actionId, {
          id:          actionId,
          tool,
          params: _snapParams(params),
          reason,
          originalMsg: _clone(msg),
          ts:          new Date().toISOString(),
          deadline:    new Date(Date.now() + node.timeout).toISOString(),
          _timer,
        });

        // Limite la taille de la file
        if (node._queue.size > node.maxQueue) {
          // v2.17 — l'éviction n'est plus silencieuse : la demande évincée
          // reçoit une réponse terminale corrélée (Output 3), l'historique
          // en garde la trace, et un warn est émis. Jamais exécutée.
          const oldestId = [...node._queue.keys()][0];
          const old = node._queue.get(oldestId);
          clearTimeout(old._timer);
          node._queue.delete(oldestId);
          actionAuthority.cancelApprovalRequest(old.originalMsg.redclaw_safety?.approvalRequestId);
          const entry = _record(old, "evicted", { evictedBy: actionId });
          node.warn(`[Approval] File pleine (${node.maxQueue}) : « ${old.tool} » évincée sans décision`);
          send([null, null, {
            ..._clone(old.originalMsg),
            payload: `Évincé : file d'approbation pleine (${node.maxQueue}) — ${old.tool}`,
            redclaw_approval: entry,
          }]);
        }

        _updateStatus();
        node.status({ fill:"yellow", shape:"ring",
          text:`⏳ ${node._queue.size} en attente · ${tool}` });

        // Output 1 → Dashboard
        send([_queueMsg(msg), null, null]);
        done(); return;
      }

      done();
    });

    // ── Helpers d'intégrité (v2.17) ─────────────────────────────────────────
    function _snapParams(p) {
      try { return JSON.parse(JSON.stringify(p ?? {})); }
      catch (_) { return { ...(p || {}) }; }
    }
    function _clone(m) { return RED.util.cloneMessage(m); }
    // Entrée d'historique PUBLIQUE : aucun _timer, aucun originalMsg.
    function _record(action, decision, extra = {}) {
      const entry = {
        id: action.id, tool: action.tool, params: _snapParams(action.params),
        reason: action.reason, ts: action.ts, deadline: action.deadline,
        decision, decidedAt: new Date().toISOString(), ...extra,
      };
      node._history.unshift(entry);
      if (node._history.length > 50) node._history.pop();
      return entry;
    }

    function _queueMsg(msg) {
      const queue = [...node._queue.values()].map(a => ({
        id:       a.id,
        tool:     a.tool,
        params:   _snapParams(a.params),
        reason:   a.reason,
        ts:       a.ts,
        deadline: a.deadline,
        age:      Math.round((Date.now() - new Date(a.ts).getTime()) / 1000) + "s",
      }));
      return {
        ...msg,
        payload: {
          type:     "approval_update",
          queue,
          history:  node._history.slice(0, 10).map(h => ({ ...h, params: _snapParams(h.params) })),
          count:    node._queue.size,
        },
        // Champs directs pour ui-table
        ui_queue:   queue,
        ui_count:   node._queue.size,
      };
    }

    function _updateStatus() {
      const n = node._queue.size;
      node.status({
        fill:  n > 0 ? "yellow" : "green",
        shape: n > 0 ? "ring"   : "dot",
        text:  n > 0 ? `${n} action(s) en attente` : "File vide",
      });
    }

    node.on("close", function () {
      for (const [, a] of node._queue) clearTimeout(a._timer);
      node._queue.clear();
      node.status({});
    });
  }

  RED.nodes.registerType("neuro-approval", NeuroApprovalNode);
  RED.httpAdmin.post(
    "/redclaw/approvals/:nodeId/:actionId",
    RED.auth.needsPermission("flows.write"),
    (req, res) => {
      const reviewer = getAuthenticatedReviewer(req);
      if (!reviewer) {
        return res.status(401).json({ error: "authenticated_reviewer_required" });
      }
      const decision = req.body?.decision;
      if (decision !== "approve" && decision !== "reject") {
        return res.status(400).json({ error: "decision_must_be_approve_or_reject" });
      }
      const nodeId = req.params?.nodeId;
      const actionId = req.params?.actionId;
      if (typeof nodeId !== "string" || !nodeId.trim() ||
          typeof actionId !== "string" || !actionId.trim()) {
        return res.status(400).json({ error: "node_and_action_ids_required" });
      }
      const approvalNode = RED.nodes.getNode(nodeId);
      if (!approvalNode || approvalNode.type !== "neuro-approval") {
        return res.status(404).json({ error: "approval_node_not_found" });
      }
      if (!approvalNode.requireAuthenticatedReviewer) {
        return res.status(409).json({ error: "authenticated_review_mode_not_enabled" });
      }
      if (!approvalNode._queue.has(actionId)) {
        return res.status(404).json({ error: "pending_approval_not_found" });
      }

      const reviewMessage = {
        topic: decision,
        payload: { actionId },
        [AUTHENTICATED_REVIEWER]: reviewer,
      };
      approvalNode.receive(reviewMessage);
      return res.json({ accepted: true, actionId, decision, reviewer });
    }
  );
};
