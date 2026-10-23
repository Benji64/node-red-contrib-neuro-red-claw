"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { types } = require("node:util");

const MAX_AUTHORIZATIONS = 10000;
const DEFAULT_TTL_MS = 60000;
const MAX_TTL_MS = 300000;
const permits = new Map();
const reviews = new Map();

function issuePermit({
  tool, params, sessionId, kind = "gate", ttlMs = DEFAULT_TTL_MS, correlationId,
}) {
  if (kind === "dispatch" && correlationId === undefined) {
    throw new TypeError("dispatch permits require a correlationId");
  }
  const binding = makeBinding(tool, params, sessionId, correlationId);
  validateTtl(ttlMs);
  pruneExpired();
  if (permits.size >= MAX_AUTHORIZATIONS) {
    throw new Error("Action authorization capacity reached");
  }
  const token = randomBytes(32).toString("hex");
  permits.set(token, { ...binding, kind, expiresAt: Date.now() + ttlMs });
  return token;
}

function inspectPermit(token, tool, params, sessionId, kind = "gate", correlationId) {
  return checkPermit(token, tool, params, sessionId, kind, correlationId, false);
}

function consumePermit(token, tool, params, sessionId, kind = "gate", correlationId) {
  return checkPermit(token, tool, params, sessionId, kind, correlationId, true);
}

function revokePermit(token) {
  if (typeof token !== "string" || !token) return false;
  return permits.delete(token);
}

function registerApprovalRequest({
  tool, params, sessionId, ttlMs = DEFAULT_TTL_MS, authorize, onSettled,
}) {
  const binding = makeBinding(tool, params, sessionId);
  validateTtl(ttlMs);
  if (typeof authorize !== "function") throw new TypeError("authorize must be a function");
  if (onSettled !== undefined && typeof onSettled !== "function") {
    throw new TypeError("onSettled must be a function");
  }
  pruneExpired();
  if (reviews.size >= MAX_AUTHORIZATIONS) {
    throw new Error("Human approval request capacity reached");
  }
  const id = randomBytes(32).toString("hex");
  reviews.set(id, {
    ...binding,
    authorize,
    onSettled,
    expiresAt: Date.now() + ttlMs,
  });
  return id;
}

function approveRequest(id, tool, params, sessionId) {
  const request = reviews.get(id);
  reviews.delete(id);
  if (request?.onSettled) request.onSettled("approved");
  if (!request || request.expiresAt <= Date.now()) {
    return { allowed: false, reason: "Approval request is unknown or expired" };
  }
  if (!matches(request, tool, params, sessionId)) {
    return { allowed: false, reason: "Action changed after the safety review" };
  }
  try {
    const token = request.authorize();
    if (typeof token !== "string" || !token) {
      return { allowed: false, reason: "Safety re-evaluation did not authorize the action" };
    }
    return { allowed: true, token };
  } catch (error) {
    return {
      allowed: false,
      reason: `Safety re-evaluation failed: ${safeMessage(error)}`,
    };
  }
}

function cancelApprovalRequest(id) {
  const request = reviews.get(id);
  reviews.delete(id);
  if (request?.onSettled) request.onSettled("cancelled");
}

function makeBinding(tool, params, sessionId, correlationId) {
  if (typeof tool !== "string" || !tool.trim()) throw new TypeError("tool must be a non-empty string");
  if (typeof sessionId !== "string" || !sessionId) throw new TypeError("sessionId must be a non-empty string");
  if (correlationId !== undefined &&
      (typeof correlationId !== "string" || !correlationId)) {
    throw new TypeError("correlationId must be a non-empty string");
  }
  return {
    tool,
    sessionId,
    correlationId,
    paramsDigest: digest(params),
  };
}

function checkPermit(token, tool, params, sessionId, kind, correlationId, consume) {
  if (typeof token !== "string" || !token) {
    return { allowed: false, reason: "Missing action authorization" };
  }
  const permit = permits.get(token);
  if (consume) permits.delete(token);
  if (!permit || permit.expiresAt <= Date.now()) {
    return { allowed: false, reason: "Action authorization is unknown, expired, or already used" };
  }
  try {
    if (permit.kind !== kind || !matches(permit, tool, params, sessionId, correlationId)) {
      return { allowed: false, reason: "Action does not match its authorization" };
    }
  } catch (error) {
    return { allowed: false, reason: `Action authorization validation failed: ${safeMessage(error)}` };
  }
  return { allowed: true };
}

function matches(binding, tool, params, sessionId, correlationId) {
  const candidate = makeBinding(tool, params, sessionId, correlationId);
  return binding.tool === candidate.tool &&
    binding.sessionId === candidate.sessionId &&
    binding.correlationId === candidate.correlationId &&
    binding.paramsDigest === candidate.paramsDigest;
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value, ancestors = new Set(), depth = 0) {
  if (depth > 100) throw new TypeError("params exceed maximum nesting depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("params must contain finite numbers");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || ancestors.has(value)) throw new TypeError("params must be acyclic JSON");
  if (types.isProxy(value)) throw new TypeError("params must not contain Proxy objects");
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype :
    prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("params must use plain JSON objects");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) throw new TypeError("params must not contain sparse arrays");
        items.push(canonicalJson(value[index], ancestors, depth + 1));
      }
      return `[${items.join(",")}]`;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== "string")) throw new TypeError("params must not contain symbol keys");
    return `{${keys.sort().map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new TypeError("params must not contain accessors or hidden properties");
      }
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, ancestors, depth + 1)}`;
    }).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function validateTtl(ttlMs) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) {
    throw new TypeError(`ttlMs must be an integer between 1 and ${MAX_TTL_MS}`);
  }
}

function pruneExpired() {
  const now = Date.now();
  for (const [token, permit] of permits) {
    if (permit.expiresAt <= now) permits.delete(token);
  }
  for (const [id, review] of reviews) {
    if (review.expiresAt <= now) reviews.delete(id);
  }
}

function safeMessage(error) {
  return (error && typeof error.message === "string" ? error.message : "unknown error").slice(0, 200);
}

module.exports = {
  DEFAULT_TTL_MS,
  issuePermit,
  inspectPermit,
  consumePermit,
  revokePermit,
  registerApprovalRequest,
  approveRequest,
  cancelApprovalRequest,
};
