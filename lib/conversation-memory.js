/**
 * RedClaw - Conversation Memory
 * Persistance JSON par sessionId. Sliding window. TTL. Purge automatique.
 */
const fs   = require("fs");
const path = require("path");

class ConversationMemory {
  constructor(storageDir, options = {}) {
    this.storageDir  = storageDir;
    this.maxMessages = options.maxMessages || 50;
    this.ttlHours    = options.ttlHours    || 24;
    this._cache      = new Map();
    this._ensureDir();
    this._loadAll();
    this._cleanTimer = setInterval(() => this.purgeExpired(), 30 * 60 * 1000);
  }

  getOrCreate(sessionId) {
    if (!sessionId) sessionId = `s-${Date.now().toString(36)}`;
    if (this._cache.has(sessionId)) return this._cache.get(sessionId);
    const s = { id: sessionId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] };
    this._cache.set(sessionId, s);
    return s;
  }

  addMessage(sessionId, role, content) {
    const s = this.getOrCreate(sessionId);
    s.messages.push({ role, content: typeof content === "string" ? content : JSON.stringify(content), ts: new Date().toISOString() });
    if (s.messages.length > this.maxMessages) {
      s.messages = [s.messages[0], ...s.messages.slice(-(this.maxMessages - 1))];
    }
    s.updatedAt = new Date().toISOString();
    this._persist(s);
    return s;
  }

  getSummary(sessionId, maxExchanges = 3) {
    const s = this._cache.get(sessionId);
    if (!s || !s.messages.length) return "";
    const ex = s.messages.filter(m => m.role === "user" || m.role === "assistant").slice(-maxExchanges * 2);
    if (!ex.length) return "";
    return "Historique récent:\n" + ex.map(m => (m.role === "user" ? "U: " : "A: ") + m.content.substring(0, 120)).join("\n");
  }

  clear(sessionId)  { const s = this._cache.get(sessionId); if (s) { s.messages = []; s.updatedAt = new Date().toISOString(); this._persist(s); } }
  delete(sessionId) { this._cache.delete(sessionId); const f = this._filePath(sessionId); if (fs.existsSync(f)) fs.unlinkSync(f); }

  list() { return [...this._cache.values()].map(s => ({ id: s.id, createdAt: s.createdAt, updatedAt: s.updatedAt, count: s.messages.length })); }

  purgeExpired() {
    const cutoff = Date.now() - this.ttlHours * 3600 * 1000;
    let n = 0;
    for (const [id, s] of this._cache) {
      if (new Date(s.updatedAt).getTime() < cutoff) { this.delete(id); n++; }
    }
    return n;
  }

  destroy() { clearInterval(this._cleanTimer); }

  _filePath(id) { return path.join(this.storageDir, id.replace(/[^a-zA-Z0-9\-_]/g,"_") + ".json"); }
  _persist(s)   { try { fs.writeFileSync(this._filePath(s.id), JSON.stringify(s, null, 2), "utf8"); } catch (_) {} }
  _ensureDir()  { if (!fs.existsSync(this.storageDir)) fs.mkdirSync(this.storageDir, { recursive: true }); }
  _loadAll()    {
    try {
      for (const f of fs.readdirSync(this.storageDir).filter(f => f.endsWith(".json"))) {
        try { const s = JSON.parse(fs.readFileSync(path.join(this.storageDir, f), "utf8")); if (s.id) this._cache.set(s.id, s); } catch (_) {}
      }
    } catch (_) {}
  }
}
module.exports = ConversationMemory;
