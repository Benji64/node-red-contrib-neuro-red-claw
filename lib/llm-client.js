/**
 * RedClaw - LLM Client
 *
 * Client générique supportant plusieurs backends via une interface unique :
 *   client.chat(systemPrompt, userMessage, options) → string
 *
 * Backends :
 *   ollama      → /api/chat           (Ollama local)
 *   openai      → /v1/chat/completions (OpenAI, LM Studio, LocalAI, Jan,
 *                                       llama-cpp node en mode chat)
 *   anthropic   → /v1/messages        (Claude API)
 *   rest        → chemin configurable  (tout autre serveur)
 */

const fetch = require("node-fetch");

class LlmClient {
  /**
   * @param {object} config
   *   type            : "ollama" | "openai" | "anthropic" | "rest"
   *   baseUrl         : URL du serveur
   *   model           : nom du modèle
   *   apiKey          : clé API (openai / anthropic)
   *   timeout         : ms
   *   restPath        : chemin POST pour le mode rest
   *   restResultPath  : chemin dans la réponse JSON (ex: "choices.0.message.content")
   *   restBodyTpl     : template JSON stringifié (vars: {{system}}, {{user}}, {{model}})
   */
  constructor(config = {}) {
    this.type           = config.type    || "ollama";
    this.baseUrl        = (config.baseUrl || "http://localhost:11434").replace(/\/$/, "");
    this.model          = config.model   || "gemma3:4b";
    this.apiKey         = config.apiKey  || "";
    this.timeout        = parseInt(config.timeout, 10) || 30000;
    this.restPath       = config.restPath       || "/chat";
    this.restBodyTpl    = config.restBodyTpl    || "";
    this.restResultPath = config.restResultPath || "response";
  }

  // ─── Interface principale ──────────────────────────────────────────────────

  async chat(systemPrompt, userMessage, options = {}) {
    switch (this.type) {
      case "ollama":    return this._chatOllama(systemPrompt, userMessage, options);
      case "openai":
      case "lmstudio":
      case "localai":
      case "jan":       return this._chatOpenAI(systemPrompt, userMessage, options);
      case "anthropic": return this._chatAnthropic(systemPrompt, userMessage, options);
      case "rest":      return this._chatRest(systemPrompt, userMessage, options);
      default:          throw new Error(`Backend LLM inconnu : ${this.type}`);
    }
  }

  // ─── Ollama /api/chat ──────────────────────────────────────────────────────
  async _chatOllama(system, user, opts) {
    const body = {
      model:  this.model,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user",   content: user   },
      ],
      options: {
        temperature: opts.temperature ?? 0.1,
        num_predict: opts.maxTokens   ?? 512,
      },
    };
    const data = await this._post(`${this.baseUrl}/api/chat`, body);
    return data.message?.content?.trim() || "";
  }

  // ─── OpenAI /v1/chat/completions ──────────────────────────────────────────
  // Compatible : OpenAI, LM Studio, LocalAI, Jan,
  //              llama-cpp (node-red-contrib-llama-cpp en mode chat)
  async _chatOpenAI(system, user, opts) {
    const headers = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const body = {
      model: this.model,
      messages: [
        { role: "system", content: system },
        { role: "user",   content: user   },
      ],
      temperature: opts.temperature ?? 0.1,
      max_tokens:  opts.maxTokens   ?? 512,
      stream:      false,
    };

    const data = await this._post(
      `${this.baseUrl}/v1/chat/completions`,
      body,
      headers
    );

    // Extraction robuste — plusieurs formats possibles selon le serveur
    const content =
      // Format OpenAI standard
      data.choices?.[0]?.message?.content
      // Certains serveurs mettent le texte directement
      || data.choices?.[0]?.text
      // llama-cpp-python / text-generation-webui
      || data.choices?.[0]?.message?.text
      // Réponse directe (format simplifié)
      || data.content
      || data.response
      || data.text
      || data.message
      // Dernier recours : stringify pour debug
      || (data.choices?.length
          ? JSON.stringify(data.choices[0])
          : JSON.stringify(data));

    return typeof content === "string" ? content.trim() : JSON.stringify(content);
  }

  // ─── Anthropic /v1/messages ───────────────────────────────────────────────
  async _chatAnthropic(system, user, opts) {
    const headers = {
      "Content-Type":      "application/json",
      "x-api-key":         this.apiKey,
      "anthropic-version": "2023-06-01",
    };
    const body = {
      model:      this.model || "claude-haiku-4-5-20251001",
      max_tokens: opts.maxTokens ?? 512,
      system,
      messages: [{ role: "user", content: user }],
    };
    const data = await this._post(
      `${this.baseUrl}/v1/messages`,
      body,
      headers
    );
    return data.content?.[0]?.text?.trim() || "";
  }

  // ─── REST custom ──────────────────────────────────────────────────────────
  async _chatRest(system, user, opts) {
    let bodyStr = this.restBodyTpl || JSON.stringify({
      model:  "{{model}}",
      system: "{{system}}",
      prompt: "{{user}}",
    });

    bodyStr = bodyStr
      .replace(/{{model}}/g,  this.model)
      .replace(/{{system}}/g, system.replace(/"/g, '\\"'))
      .replace(/{{user}}/g,   user.replace(/"/g, '\\"'));

    let body;
    try { body = JSON.parse(bodyStr); }
    catch (e) { throw new Error(`REST body template invalide : ${e.message}`); }

    const headers = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const data = await this._post(
      `${this.baseUrl}${this.restPath}`,
      body,
      headers
    );
    return String(this._extractPath(data, this.restResultPath) || "");
  }

  // ─── Health check ──────────────────────────────────────────────────────────
  async healthCheck() {
    try {
      switch (this.type) {
        case "ollama": {
          const r = await fetch(`${this.baseUrl}/api/tags`,
            { signal: AbortSignal.timeout(5000) });
          if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
          const d = await r.json();
          const models = (d.models || []).map(m => m.name);
          return {
            ok: true,
            models,
            modelFound: models.some(m => m.startsWith(this.model.split(":")[0])),
          };
        }
        case "openai":
        case "lmstudio":
        case "localai":
        case "jan": {
          const h = {};
          if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
          const r = await fetch(`${this.baseUrl}/v1/models`,
            { headers: h, signal: AbortSignal.timeout(5000) });
          return { ok: r.ok, status: r.status };
        }
        case "anthropic":
          return { ok: !!this.apiKey, note: "Clé API présente" };
        default:
          return { ok: true, note: "Vérification manuelle requise" };
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ─── Utilitaires ──────────────────────────────────────────────────────────
  async _post(url, body, extraHeaders = {}) {
    let res;
    try {
      res = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json", ...extraHeaders },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(this.timeout),
      });
    } catch (e) {
      // AbortSignal.timeout() → "The user aborted a request" → message clair
      if (e.name === "AbortError" || e.name === "TimeoutError" || e.message.includes("aborted")) {
        throw new Error(
          `Timeout LLM (${this.timeout}ms) — le modèle est trop lent ou le serveur ne répond pas.` +
          ` URL: ${url} · Augmente le timeout dans llm-config.`
        );
      }
      // ECONNREFUSED / network error
      throw new Error(`Connexion LLM impossible (${e.code || e.message}) — URL: ${url}`);
    }
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`LLM HTTP ${res.status} sur ${url}: ${txt.slice(0, 200)}`);
    }
    return res.json();
  }

  _extractPath(obj, path) {
    if (!path) return obj;
    return path.split(".").reduce((acc, key) =>
      acc == null ? undefined : acc[isNaN(key) ? key : parseInt(key, 10)]
    , obj);
  }

  label() {
    const labels = {
      ollama:"Ollama", openai:"OpenAI", anthropic:"Anthropic",
      lmstudio:"LM Studio", localai:"LocalAI", jan:"Jan", rest:"REST",
    };
    return `${labels[this.type] || this.type} · ${this.model}`;
  }
}

module.exports = LlmClient;
