const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const EmbeddingClient = require("../../lib/embedding-client");

async function withServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

test("embeds with Ollama, trims input, and accepts both response shapes", async t => {
  const calls = [];
  const baseUrl = await withServer(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, body: JSON.parse(body) });
    if (calls.length === 1) json(res, 200, { embeddings: [[0.1, 0.2]] });
    else json(res, 200, { embedding: [0.3, 0.4] });
  });
  const client = new EmbeddingClient({ baseUrl: `${baseUrl}/`, model: "local-embed" });

  assert.deepEqual(await client.embed("  hello  "), [0.1, 0.2]);
  assert.deepEqual(await client.embed("world"), [0.3, 0.4]);
  assert.deepEqual(calls.map(call => call.url), ["/api/embed", "/api/embed"]);
  assert.deepEqual(calls[0].body, { model: "local-embed", input: "hello" });
  assert.deepEqual(await client.embed("   "), []);
  assert.equal(calls.length, 2);
  assert.deepEqual(await client.healthCheck(), { ok: true, dims: 2, model: "local-embed" });
});

test("uses the OpenAI-compatible endpoint and authorization header", async t => {
  let received;
  const baseUrl = await withServer(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) };
    json(res, 200, { data: [{ embedding: [1, 2, 3] }] });
  });
  const client = new EmbeddingClient({
    type: "openai",
    baseUrl,
    model: "text-embedding",
    apiKey: "test-token",
  });

  assert.deepEqual(await client.embed("input"), [1, 2, 3]);
  assert.equal(received.url, "/v1/embeddings");
  assert.equal(received.authorization, "Bearer test-token");
  assert.deepEqual(received.body, { model: "text-embedding", input: "input" });
});

test("batches requests in groups of at most eight and propagates HTTP errors", async t => {
  let active = 0;
  let maxActive = 0;
  let total = 0;
  const baseUrl = await withServer(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body).input;
    total++;
    active++;
    maxActive = Math.max(maxActive, active);
    setTimeout(() => {
      active--;
      if (req.url === "/api/embed" && input !== "failure") json(res, 200, { embedding: [total] });
      else json(res, 503, { error: "offline" });
    }, 10);
  });
  const client = new EmbeddingClient({ baseUrl });

  const vectors = await client.embedBatch(Array.from({ length: 9 }, (_, index) => `text-${index}`));
  assert.equal(vectors.length, 9);
  assert.ok(maxActive <= 8);
  assert.ok(maxActive > 1);
  await assert.rejects(
    client.embed("failure"),
    /\[EmbeddingClient\] embed échoué : Ollama embed HTTP 503/,
  );
  assert.deepEqual(await client.healthCheck(), { ok: true, dims: 1, model: "mxbai-embed-large" });
});
