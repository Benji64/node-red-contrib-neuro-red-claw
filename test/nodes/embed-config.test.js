const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const registerEmbedConfig = require("../../nodes/embed-config");

async function startEmbeddingServer(t, vector = [0.2, 0.4, 0.6]) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(body),
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ embedding: vector }] }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

function mockRed() {
  const registered = {};
  const routes = {};
  const warnings = [];
  const permission = name => `permission:${name}`;
  const RED = {
    nodes: {
      createNode(node) {
        node.type = "embed-config";
        node.credentials = { apiKey: "stored-secret" };
        node.warn = warning => warnings.push(warning);
      },
      registerType(type, constructor, options) {
        registered[type] = { constructor, options };
      },
    },
    httpAdmin: {
      post(route, auth, handler) {
        routes[route] = { auth, handler };
      },
    },
    auth: { needsPermission: permission },
  };
  return { RED, registered, routes, permission, warnings };
}

function responseCapture() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("registers the API key as a Node-RED credential and reads it from credentials", () => {
  const { RED, registered } = mockRed();
  registerEmbedConfig(RED);
  const node = new registered["embed-config"].constructor({
    backend: "openai",
    baseUrl: "https://example.test",
    model: "embed-model",
  });

  assert.deepEqual(registered["embed-config"].options, {
    credentials: { apiKey: { type: "password" } },
  });
  assert.equal(node.apiKey, "stored-secret");
  assert.equal(node.backend, "openai");
  assert.equal(node.type, "embed-config");
});

test("ignores Node-RED's reserved type field when selecting the embedding backend", () => {
  const { RED, registered } = mockRed();
  registerEmbedConfig(RED);
  const node = new registered["embed-config"].constructor({
    type: "embed-config",
  });

  assert.equal(node.backend, "ollama");
  assert.equal(node.type, "embed-config");
});

test("reads embedding configuration without invoking getters or Proxy traps", () => {
  const { RED, registered, warnings } = mockRed();
  registerEmbedConfig(RED);
  let getterInvoked = false;
  const config = {};
  for (const key of ["backend", "baseUrl", "model", "timeout", "dims", "restPath"]) {
    Object.defineProperty(config, key, {
      enumerable: true,
      get() {
        getterInvoked = true;
        throw new Error(`${key} getter invoked`);
      },
    });
  }

  const node = new registered["embed-config"].constructor(config);
  assert.equal(getterInvoked, false);
  assert.equal(node.backend, "ollama");
  assert.equal(node.baseUrl, "http://localhost:11434");
  assert.equal(node.model, "mxbai-embed-large");
  assert.equal(node.timeout, 15000);
  assert.equal(node.dims, 0);
  assert.equal(node.restPath, "/embed");
  assert.equal(warnings.length, 6);

  let trapInvoked = false;
  const proxyConfig = new Proxy({}, {
    getOwnPropertyDescriptor() {
      trapInvoked = true;
      throw new Error("configuration Proxy trap invoked");
    },
  });
  const proxyNode = new registered["embed-config"].constructor(proxyConfig);
  assert.equal(trapInvoked, false);
  assert.equal(proxyNode.backend, "ollama");
  assert.equal(proxyNode.timeout, 15000);
  assert.equal(proxyNode.dims, 0);
  assert.equal(warnings.length, 7);
});

test("uses safe defaults for malformed embedding config and preserves valid settings", () => {
  const { RED, registered, warnings } = mockRed();
  registerEmbedConfig(RED);
  const invalid = new registered["embed-config"].constructor({
    backend: "unknown",
    baseUrl: { toString: () => "https://unexpected.example" },
    model: 42,
    timeout: "15seconds",
    dims: "-1",
    restPath: 3,
  });
  assert.equal(invalid.backend, "ollama");
  assert.equal(invalid.baseUrl, "http://localhost:11434");
  assert.equal(invalid.model, "mxbai-embed-large");
  assert.equal(invalid.timeout, 15000);
  assert.equal(invalid.dims, 0);
  assert.equal(invalid.restPath, "/embed");
  assert.equal(warnings.length, 6);

  const valid = new registered["embed-config"].constructor({
    backend: "rest",
    baseUrl: " https://api.example.test/ ",
    model: " embed-model ",
    timeout: "25000",
    dims: "768",
    restPath: " /v1/embed ",
  });
  assert.equal(valid.backend, "rest");
  assert.equal(valid.baseUrl, "https://api.example.test");
  assert.equal(valid.model, "embed-model");
  assert.equal(valid.timeout, 25000);
  assert.equal(valid.dims, 768);
  assert.equal(valid.restPath, "/v1/embed");
  assert.equal(warnings.length, 6);
});

test("strictly parses configured dimensions and enforces the detected vector length", async t => {
  const { baseUrl } = await startEmbeddingServer(t);
  const { RED, registered } = mockRed();
  registerEmbedConfig(RED);

  const automatic = new registered["embed-config"].constructor({
    backend: "openai",
    baseUrl,
    model: "embed-model",
    dims: "3dimensions",
  });
  assert.equal(automatic.dims, 0);
  assert.deepEqual(await automatic.embed("test"), [0.2, 0.4, 0.6]);
  assert.equal(automatic.dims, 3);

  const mismatched = new registered["embed-config"].constructor({
    backend: "openai",
    baseUrl,
    model: "embed-model",
    dims: 2,
  });
  await assert.rejects(mismatched.embed("test"), /Dimension embedding incohérente/);
});

test("rejects embedding responses containing non-numeric vector values", async t => {
  const { baseUrl } = await startEmbeddingServer(t, [0.2, "0.4"]);
  const { RED, registered } = mockRed();
  registerEmbedConfig(RED);
  const node = new registered["embed-config"].constructor({
    backend: "openai",
    baseUrl,
    model: "embed-model",
  });

  await assert.rejects(node.embed("test"), /Vecteur embedding invalide/);
});

test("the authorized editor endpoint tests OpenAI embeddings and validates input", async t => {
  const { baseUrl, requests } = await startEmbeddingServer(t);
  const { RED, routes } = mockRed();
  registerEmbedConfig(RED);

  assert.equal(routes["/redclaw/embed/test"].auth, "permission:flows.write");
  const handler = routes["/redclaw/embed/test"].handler;
  const res = responseCapture();
  await handler({
    body: {
      backend: "openai",
      baseUrl,
      model: "test-model",
      timeout: 2000,
      apiKey: "editor-key",
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, dims: 3, model: "test-model", type: "openai" });
  assert.equal(requests[0].url, "/v1/embeddings");
  assert.equal(requests[0].authorization, "Bearer editor-key");
  assert.equal(requests[0].body.input, "test neuro-red-claw");

  const invalidResponse = responseCapture();
  await handler({ body: { backend: "openai", baseUrl: "file:///etc", model: "m" } }, invalidResponse);
  assert.equal(invalidResponse.statusCode, 400);

  const prefixedResponse = responseCapture();
  await handler({
    body: { backend: "openai", baseUrl: `${baseUrl}/prefix/`, model: "test-model" },
  }, prefixedResponse);
  assert.equal(prefixedResponse.statusCode, 200);
  assert.equal(requests[1].url, "/prefix/v1/embeddings");

  const missingResponse = responseCapture();
  await handler({ body: { backend: "unknown", baseUrl, model: "m" } }, missingResponse);
  assert.equal(missingResponse.statusCode, 400);

  const legacyResponse = responseCapture();
  await handler({
    body: { type: "openai", baseUrl, model: "legacy-model" },
  }, legacyResponse);
  assert.equal(legacyResponse.statusCode, 200);
  assert.equal(legacyResponse.body.type, "openai");
});

test("the editor endpoint rejects malformed embedding vectors", async t => {
  const { baseUrl } = await startEmbeddingServer(t, [0.2, null]);
  const { RED, routes } = mockRed();
  registerEmbedConfig(RED);
  const response = responseCapture();

  await routes["/redclaw/embed/test"].handler({
    body: { backend: "openai", baseUrl, model: "test-model" },
  }, response);

  assert.equal(response.statusCode, 502);
  assert.match(response.body.error, /Vecteur embedding invalide/);
});
