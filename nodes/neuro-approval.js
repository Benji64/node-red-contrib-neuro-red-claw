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

module.exports = function (RED) {
  function NeuroApprovalNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.timeout     = parseInt(config.timeout, 10)  || 300000; // 5min
    node.maxQueue    = parseInt(config.maxQueue, 10)  || 20;
    node.autoReject  = config.autoReject === true;

    // File d'attente : actionId → { id, tool, params, msg, ts, deadline, reason }
    node._queue   = new Map();
    node._history = []; // actions traitées

    _updateStatus();

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (e) { if (e) node.error(e, msg); };

      // ── Décision depuis Dashboard (approve / reject) ──────────────────
      if (msg.topic === "approve" || msg.topic === "reject") {
        const actionId = msg.payload?.actionId || msg.payload;
        const action   = node._queue.get(actionId);

        if (!action) {
          node.warn(`[Approval] Action "${actionId}" introuvable ou expirée`);
          done(); return;
        }

        clearTimeout(action._timer);
        node._queue.delete(actionId);

        const decision = {
          ...action,
          decision:    msg.topic,
          decidedAt:   new Date().toISOString(),
          decidedBy:   msg.decidedBy || "dashboard",
        };
        node._history.unshift(decision);
        if (node._history.length > 50) node._history.pop();

        _updateStatus();

        if (msg.topic === "approve") {
          node.status({ fill:"green", shape:"dot", text:`✓ ${action.tool}` });
          // Renvoie le msg original vers le MCP Router
          send([_queueMsg(msg), { ...action.originalMsg }, null]);
        } else {
          node.status({ fill:"red", shape:"ring", text:`✗ ${action.tool}` });
          send([_queueMsg(msg), null, {
            ...msg,
            payload: `Refusé par opérateur : ${action.tool}`,
            redclaw_approval: { ...decision },
          }]);
        }
        done(); return;
      }

      // ── Nouvelle action depuis security-gate ou redclaw-policy ────────
      if (msg.redclaw?.tool || msg.redclaw_policy) {
        const tool    = msg.redclaw?.tool || "action_inconnue";
        const params  = msg.redclaw?.params || {};
        const reason  = msg.redclaw_policy?.reason || msg.redclaw_security?.reason || "";
        const actionId = randomUUID().slice(0, 8);

        // Expire automatiquement si timeout
        const _timer = setTimeout(() => {
          if (!node._queue.has(actionId)) return;
          const action = node._queue.get(actionId);
          node._queue.delete(actionId);
          node._history.unshift({ ...action, decision: "timeout", decidedAt: new Date().toISOString() });
          if (node._history.length > 50) node._history.pop();

          if (node.autoReject) {
            send([_queueMsg(msg), null, {
              ...msg,
              payload: `Timeout : ${tool} (${node.timeout/1000}s sans décision)`,
            }]);
          }
          _updateStatus();
          node.warn(`[Approval] Action "${tool}" expirée après ${node.timeout/1000}s`);
        }, node.timeout);

        node._queue.set(actionId, {
          id:          actionId,
          tool,
          params,
          reason,
          originalMsg: { ...msg },
          ts:          new Date().toISOString(),
          deadline:    new Date(Date.now() + node.timeout).toISOString(),
          _timer,
        });

        // Limite la taille de la file
        if (node._queue.size > node.maxQueue) {
          const oldest = [...node._queue.keys()][0];
          clearTimeout(node._queue.get(oldest)._timer);
          node._queue.delete(oldest);
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

    function _queueMsg(msg) {
      const queue = [...node._queue.values()].map(a => ({
        id:       a.id,
        tool:     a.tool,
        params:   a.params,
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
          history:  node._history.slice(0, 10),
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
};
