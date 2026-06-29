/**
 * RedClaw - Security Policy Engine
 * Valide chaque tool call : allowlist, denylist, rate limit, patterns dangereux, confirmation.
 */
class SecurityPolicy {
  constructor(config = {}) {
    this.rules          = config.rules          || [];
    this.defaultAction  = config.defaultAction  || "allow";
    this.globalRateLimit = config.globalRateLimit || null;
    this._rates         = new Map();
    this._cleanTimer    = setInterval(() => this._cleanRates(), 5 * 60 * 1000);
  }

  evaluate(toolName, params, sessionId) {
    // Rate limit global
    if (this.globalRateLimit && !this._rateCheck(`g:${sessionId}`, this.globalRateLimit.maxCalls, this.globalRateLimit.windowMs))
      return { allowed: false, action: "deny", reason: `Rate limit global dépassé`, requireConfirm: false };

    // Patterns dangereux
    const danger = this._dangerCheck(params);
    if (danger) return { allowed: false, action: "deny", reason: `Paramètre dangereux: ${danger}`, requireConfirm: false };

    // Règles spécifiques
    const rules = this.rules.filter(r => r.tool === toolName || r.tool === "*" || (r.tool?.endsWith("*") && toolName.startsWith(r.tool.slice(0,-1))));
    for (const r of rules) {
      if (r.rateLimit && !this._rateCheck(`${sessionId}:${toolName}`, r.rateLimit.maxCalls, r.rateLimit.windowMs))
        return { allowed: false, action: "deny", reason: r.reason || `Rate limit "${toolName}"`, requireConfirm: false, rule: r };
      if (r.paramRules) { const e = this._validateParams(params, r.paramRules); if (e) return { allowed: false, action: "deny", reason: e, requireConfirm: false, rule: r }; }
      if (r.action === "deny")    return { allowed: false, action: "deny",    reason: r.reason || `"${toolName}" interdit`, requireConfirm: false, rule: r };
      if (r.action === "confirm") return { allowed: true,  action: "confirm", reason: r.reason || `Confirmation requise`, requireConfirm: true,  rule: r };
    }

    if (!rules.length && this.defaultAction === "deny")
      return { allowed: false, action: "deny", reason: `"${toolName}" non autorisé (deny par défaut)`, requireConfirm: false };

    return { allowed: true, action: "allow", requireConfirm: false };
  }

  _rateCheck(key, max, window) {
    const now = Date.now();
    const list = (this._rates.get(key) || []).filter(t => now - t < window);
    if (list.length >= max) return false;
    list.push(now); this._rates.set(key, list); return true;
  }
  _cleanRates() { const now = Date.now(); for (const [k,v] of this._rates) { const r = v.filter(t => now-t < 3600000); if (!r.length) this._rates.delete(k); else this._rates.set(k,r); } }
  _dangerCheck(p) { const s = JSON.stringify(p||{}); const pats = [/\.\.\//,/[;&|`$()]/,/DROP\s+TABLE/i,/rm\s+-rf/i,/\/etc\/passwd/i,/eval\s*\(/i]; for (const r of pats) if (r.test(s)) return r.toString(); return null; }
  _validateParams(p, rules) { for (const [k,r] of Object.entries(rules)) { const v = p?.[k]; if (r.required && !v) return `"${k}" requis`; if (v !== undefined && r.type && typeof v !== r.type) return `"${k}" doit être ${r.type}`; if (r.maxLength && typeof v === "string" && v.length > r.maxLength) return `"${k}" trop long`; if (r.allowedValues && !r.allowedValues.includes(v)) return `"${k}" valeur non autorisée`; } return null; }
  destroy() { clearInterval(this._cleanTimer); }
}
module.exports = SecurityPolicy;
