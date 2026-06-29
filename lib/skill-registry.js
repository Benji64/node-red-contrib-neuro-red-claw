/**
 * RedClaw v1.6 — Skill Registry
 * Registre vivant de toutes les compétences actives dans le graphe Node-RED.
 */
class SkillRegistry {
  constructor() {
    this._skills = new Map();
  }

  register(skillName, nodeId, config = {}) {
    const existing = this._skills.get(skillName);
    this._skills.set(skillName, {
      nodeId,
      name:         skillName,
      context:      config.context   || "",
      tools:        config.tools     || "",
      mcpServer:    config.mcpServer || "",
      registeredAt: existing?.registeredAt || new Date().toISOString(),
      lastActive:   new Date().toISOString(),
      status:       "active",
    });
  }

  touch(skillName) {
    const s = this._skills.get(skillName);
    if (s) { s.lastActive = new Date().toISOString(); s.status = "active"; }
  }

  unregister(skillName) {
    const s = this._skills.get(skillName);
    if (s) s.status = "offline";
  }

  all()   { return [...this._skills.values()]; }
  get(n)  { return this._skills.get(n) || null; }
  names() { return [...this._skills.keys()]; }

  buildCapabilitiesIndex() {
    return this.all()
      .filter(s => s.status !== "offline")
      .map(s => {
        const ctx   = s.context ? s.context.split("\n")[0].slice(0, 80) : "";
        const tools = s.tools   ? `tools: ${s.tools}` : "";
        return `[${s.name}] ${ctx}${tools ? " — " + tools : ""}`;
      }).join("\n");
  }

  snapshot(memoryStore = null, ticketStore = null) {
    return this.all().map(s => {
      const snap = { ...s };
      if (memoryStore) snap.recentMemory = memoryStore.getSummary(s.name, 3);
      if (ticketStore) {
        snap.activeTickets   = ticketStore.recent(5, { skill: s.name, status: "running" }).length;
        snap.lastTicketError = ticketStore.recent(1, { skill: s.name, status: "failed" })[0]?.error || null;
      }
      return snap;
    });
  }
}

const instance = new SkillRegistry();
module.exports = instance;
module.exports.SkillRegistry = SkillRegistry;
