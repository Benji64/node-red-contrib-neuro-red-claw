/**
 * neuro-red-claw — Embed Config
 *
 * Nœud de configuration pour les modèles d'embedding.
 * Même principe que llm-config mais pour la vectorisation.
 *
 * Backends supportés :
 *   ollama   → POST /api/embed          (mxbai-embed-large, nomic-embed-text…)
 *   openai   → POST /v1/embeddings      (text-embedding-3-small…)
 *   localai  → POST /v1/embeddings      (compatible OpenAI)
 *   rest     → chemin configurable
 */

const fetch = require("node-fetch");
const { parseFiniteInteger, timerDelayOrDefault } = require("../lib/numeric");
const { types } = require("node:util");

function validateEmbeddingVector(vector, expectedDims) {
  if (!Array.isArray(vector) || vector.length === 0 ||
      !vector.every(value => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("Vecteur embedding invalide — un tableau non vide de nombres finis est requis");
  }
  if (expectedDims > 0 && vector.length !== expectedDims) {
    throw new Error(`Dimension embedding incohérente : attendu ${expectedDims}, reçu ${vector.length}`);
  }
  return vector;
}

module.exports = function (RED) {
  function EmbedConfigNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    let invalidConfigWarned = false;
    function readConfigValue(key) {
      if (!config || typeof config !== "object" || types.isProxy(config)) {
        if (!invalidConfigWarned) {
          node.warn("[Embed Config] Configuration must be a plain object; using defaults");
          invalidConfigWarned = true;
        }
        return { present: false, valid: false };
      }
      const descriptor = Object.getOwnPropertyDescriptor(config, key);
      if (!descriptor) return { present: false, valid: true };
      if (!Object.hasOwn(descriptor, "value")) {
        node.warn(`[Embed Config] Configuration "${key}" must be a data property; using its default`);
        return { present: true, valid: false };
      }
      return { present: true, valid: true, value: descriptor.value };
    }

    function configuredString(key, fallback) {
      const configured = readConfigValue(key);
      if (!configured.valid || !configured.present || configured.value === undefined) {
        return fallback;
      }
      if (typeof configured.value !== "string") {
        node.warn(`[Embed Config] Configuration "${key}" must be a string; using its default`);
        return fallback;
      }
      return configured.value.trim() || fallback;
    }

    const configuredBackend = readConfigValue("backend");
    let backendValue = "ollama";
    if (configuredBackend.valid && configuredBackend.present &&
        configuredBackend.value !== undefined && configuredBackend.value !== null &&
        configuredBackend.value !== "") {
      backendValue = configuredBackend.value;
    } else if (configuredBackend.valid) {
      const configuredType = readConfigValue("type");
      if (configuredType.valid && configuredType.value !== "embed-config" &&
          configuredType.value !== undefined && configuredType.value !== null) {
        backendValue = configuredType.value;
      }
    }
    const backends = new Set(["ollama", "openai", "localai", "rest"]);
    if (typeof backendValue !== "string" || !backends.has(backendValue)) {
      node.warn('[Embed Config] Backend invalid; using "ollama"');
      node.backend = "ollama";
    } else {
      node.backend = backendValue;
    }
    node.baseUrl = configuredString("baseUrl", "http://localhost:11434").replace(/\/$/, "");
    node.model = configuredString("model", "mxbai-embed-large");
    node.apiKey  = (node.credentials && node.credentials.apiKey) || "";
    const configuredTimeout = readConfigValue("timeout");
    node.timeout = timerDelayOrDefault(
      configuredTimeout.valid ? configuredTimeout.value : undefined,
      15000,
    );
    if (configuredTimeout.valid && configuredTimeout.present &&
        configuredTimeout.value !== undefined &&
        timerDelayOrDefault(configuredTimeout.value, 0) === 0) {
      node.warn('[Embed Config] Configuration "timeout" must be a positive timer delay; using 15000');
    }
    const configuredDims = readConfigValue("dims");
    const dims = configuredDims.valid ? parseFiniteInteger(configuredDims.value) : null;
    node.dims    = dims !== null && dims >= 0 ? dims : 0;
    if (configuredDims.valid && configuredDims.present &&
        configuredDims.value !== undefined && (dims === null || dims < 0)) {
      node.warn('[Embed Config] Configuration "dims" must be a non-negative integer; using automatic detection');
    }
    node.restPath = configuredString("restPath", "/embed");

    function acceptVector(vector) {
      const validated = validateEmbeddingVector(vector, node.dims);
      if (node.dims === 0) node.dims = validated.length;
      return validated;
    }

    node.label = () => `${node.backend} · ${node.model}`;

    /**
     * Embed un texte → vecteur
     */
    node.embed = async function (text) {
      const clean = String(text || "").trim().slice(0, 8192);
      if (!clean) return [];

      switch (node.backend) {
        case "ollama":  return _embedOllama(clean);
        case "openai":
        case "localai": return _embedOpenAI(clean);
        case "rest":    return _embedRest(clean);
        default:        throw new Error(`Type embedding inconnu : ${node.backend}`);
      }
    };

    /**
     * Embed un tableau de textes
     */
    node.embedBatch = async function (texts) {
      const results = [];
      for (let i = 0; i < texts.length; i += 8) {
        const batch = texts.slice(i, i + 8);
        const vecs  = await Promise.all(batch.map(t => node.embed(t)));
        results.push(...vecs);
      }
      return results;
    };

    /**
     * Health check
     */
    node.healthCheck = async function () {
      try {
        const vec = await node.embed("test neuro-red-claw");
        return { ok: true, dims: vec.length, model: node.model, type: node.backend };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    };

    // ─── Backends ──────────────────────────────────────────────────────────

    async function _embedOllama(text) {
      const res = await fetch(`${node.baseUrl}/api/embed`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ model: node.model, input: text }),
        signal:  AbortSignal.timeout(node.timeout),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Ollama embed HTTP ${res.status}: ${err.slice(0,100)}`);
      }
      const data = await res.json();
      const vec  = data.embeddings?.[0] || data.embedding;
      return acceptVector(vec);
    }

    async function _embedOpenAI(text) {
      const headers = { "Content-Type": "application/json" };
      if (node.apiKey) headers["Authorization"] = `Bearer ${node.apiKey}`;
      const res = await fetch(`${node.baseUrl}/v1/embeddings`, {
        method: "POST",
        headers,
        body:   JSON.stringify({ model: node.model, input: text }),
        signal: AbortSignal.timeout(node.timeout),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Embed HTTP ${res.status}: ${err.slice(0,100)}`);
      }
      const data = await res.json();
      const vec  = data.data?.[0]?.embedding;
      return acceptVector(vec);
    }

    async function _embedRest(text) {
      const res  = await fetch(`${node.baseUrl}${node.restPath}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ model: node.model, input: text, text }),
        signal:  AbortSignal.timeout(node.timeout),
      });
      if (!res.ok) throw new Error(`REST embed HTTP ${res.status}`);
      const data = await res.json();
      // Cherche le vecteur dans plusieurs chemins courants
      const vec  = data.embedding || data.embeddings?.[0] ||
                   data.data?.[0]?.embedding || data.vector;
      return acceptVector(vec);
    }
  }

  RED.nodes.registerType("embed-config", EmbedConfigNode, {
    credentials: { apiKey: { type: "password" } },
  });

  RED.httpAdmin.post("/redclaw/embed/test",
    RED.auth.needsPermission("flows.write"),
    async (req, res) => {
      const { baseUrl, model, timeout, restPath, apiKey } = req.body || {};
      const backend = req.body && (req.body.backend || req.body.type);
      if (!["ollama", "openai", "localai", "rest"].includes(backend) ||
          typeof baseUrl !== "string" || !baseUrl.trim() ||
          typeof model !== "string" || !model.trim()) {
        return res.status(400).json({ error: "Configuration d'embedding invalide" });
      }

      const cleanBaseUrl = baseUrl.trim().replace(/\/+$/, "");
      let parsedBaseUrl;
      try {
        parsedBaseUrl = new URL(cleanBaseUrl);
        if (!["http:", "https:"].includes(parsedBaseUrl.protocol) ||
            parsedBaseUrl.username || parsedBaseUrl.password ||
            parsedBaseUrl.search || parsedBaseUrl.hash) {
          throw new Error("URL HTTP(S) sans credentials, query ou fragment requise");
        }
      } catch (error) {
        return res.status(400).json({ error: `URL d'embedding invalide : ${error.message}` });
      }

      const requestTimeout = Math.min(
        Math.max(timerDelayOrDefault(timeout, 15000), 1000),
        60000
      );
      let endpoint;
      let body;
      const headers = { "Content-Type": "application/json" };
      if (backend === "ollama") {
        endpoint = `${cleanBaseUrl}/api/embed`;
        body = { model: model.trim(), input: "test neuro-red-claw" };
      } else if (backend === "openai" || backend === "localai") {
        endpoint = `${cleanBaseUrl}/v1/embeddings`;
        body = { model: model.trim(), input: "test neuro-red-claw" };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      } else {
        const path = typeof restPath === "string" && restPath.startsWith("/") ? restPath : "/embed";
        endpoint = `${cleanBaseUrl}${path}`;
        body = { model: model.trim(), input: "test neuro-red-claw", text: "test neuro-red-claw" };
      }

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(requestTimeout),
        });
        if (!response.ok) {
          const message = (await response.text()).slice(0, 200);
          return res.status(502).json({ error: `Embed HTTP ${response.status}: ${message}` });
        }
        const data = await response.json();
        const vector = validateEmbeddingVector(
          data.embeddings?.[0] || data.embedding || data.data?.[0]?.embedding || data.vector,
          0
        );
        return res.json({ ok: true, dims: vector.length, model: model.trim(), type: backend });
      } catch (error) {
        return res.status(502).json({ error: `Test embedding impossible : ${error.message}` });
      }
    }
  );
};
