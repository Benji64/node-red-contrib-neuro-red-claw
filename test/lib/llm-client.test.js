const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const LlmClient = require("../../lib/llm-client");

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

test("sends Ollama chat options and extracts the assistant response", async t => {
  let request;
  const baseUrl = await withServer(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    request = { url: req.url, body: JSON.parse(body) };
    json(res, 200, { message: { content: "  Answer  " } });
  });
  const client = new LlmClient({ baseUrl, model: "local-chat" });

  assert.equal(await client.chat("system", "question", { temperature: 0, maxTokens: 10 }), "Answer");
  assert.equal(request.url, "/api/chat");
  assert.deepEqual(request.body.options, { temperature: 0, num_predict: 10 });
  assert.deepEqual(request.body.messages, [
    { role: "system", content: "system" },
    { role: "user", content: "question" },
  ]);
});

test("aborts an in-flight chat request when its signal is cancelled", async t => {
  let requestReceived;
  let responseClosed;
  const received = new Promise(resolve => { requestReceived = resolve; });
  const closed = new Promise(resolve => { responseClosed = resolve; });
  const baseUrl = await withServer(t, (req, res) => {
    requestReceived();
    res.once("close", responseClosed);
  });
  const controller = new AbortController();
  const client = new LlmClient({ baseUrl, model: "local-chat", timeout: 60000 });
  const pending = client.chat("system", "question", { signal: controller.signal });

  await received;
  controller.abort();

  await assert.rejects(pending, /aborted/i);
  await closed;
});

test("aborts an in-flight chat request when the configured timeout expires", async t => {
  let requestReceived;
  let responseClosed;
  const received = new Promise(resolve => { requestReceived = resolve; });
  const closed = new Promise(resolve => { responseClosed = resolve; });
  const baseUrl = await withServer(t, (req, res) => {
    requestReceived();
    res.once("close", responseClosed);
  });
  const client = new LlmClient({ baseUrl, model: "local-chat", timeout: 50 });
  const pending = client.chat("system", "question");

  await received;
  await assert.rejects(pending, /Timeout LLM \(50ms\)/);
  await closed;
});

test("keeps the configured timeout active while reading the response body", async t => {
  let requestReceived;
  let responseClosed;
  const received = new Promise(resolve => { requestReceived = resolve; });
  const closed = new Promise(resolve => { responseClosed = resolve; });
  const baseUrl = await withServer(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.flushHeaders();
    requestReceived();
    res.once("close", responseClosed);
  });
  const client = new LlmClient({ baseUrl, model: "local-chat", timeout: 50 });

  const pending = client.chat("system", "question");
  await received;
  await assert.rejects(pending, /Timeout LLM \(50ms\)/);
  await closed;
});

test("supports OpenAI-compatible and Anthropic response formats", async t => {
  const received = [];
  const baseUrl = await withServer(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    if (req.url === "/v1/messages") json(res, 200, { content: [{ text: " Claude answer " }] });
    else json(res, 200, { choices: [{ message: { content: " OpenAI answer " } }] });
  });
  const openai = new LlmClient({ type: "openai", baseUrl, apiKey: "secret", model: "gpt-local" });
  const anthropic = new LlmClient({ type: "anthropic", baseUrl, apiKey: "claude-secret", model: "claude-local" });

  assert.equal(await openai.chat("system", "question"), "OpenAI answer");
  assert.equal(await anthropic.chat("system", "question"), "Claude answer");
  assert.equal(received[0].headers.authorization, "Bearer secret");
  assert.deepEqual(received[0].body.messages[0], { role: "system", content: "system" });
  assert.equal(received[1].headers["x-api-key"], "claude-secret");
  assert.equal(received[1].headers["anthropic-version"], "2023-06-01");
  assert.equal(received[1].body.max_tokens, 512);
});

test("uses configurable REST path and response path; reports malformed templates and HTTP errors", async t => {
  let received;
  const baseUrl = await withServer(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received = { url: req.url, body: JSON.parse(body) };
    if (req.url === "/custom") json(res, 200, { result: { text: "REST answer" } });
    else {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("backend unavailable");
    }
  });
  const client = new LlmClient({
    type: "rest",
    baseUrl: `${baseUrl}/`,
    restPath: "custom",
    restBodyTpl: '{"model":"{{model}}","system":"{{system}}","prompt":"{{user}}"}',
    restResultPath: "result.text",
  });

  const system = 'Instructions with a quote: "stay literal"';
  const user = "line one\nline two with slash \\ and quote \"";
  assert.equal(await client.chat(system, user), "REST answer");
  assert.equal(received.url, "/custom");
  assert.deepEqual(received.body, { model: "gemma3:4b", system, prompt: user });
  assert.deepEqual(await client.healthCheck(), { ok: true, note: "Vérification manuelle requise" });

  const rootResult = new LlmClient({
    type: "rest",
    baseUrl,
    restPath: "/custom",
    restResultPath: "",
  });
  assert.equal(
    await rootResult.chat("system", "question"),
    JSON.stringify({ result: { text: "REST answer" } })
  );

  const missingResult = new LlmClient({
    type: "rest",
    baseUrl,
    restPath: "/custom",
    restResultPath: "missing",
  });
  await assert.rejects(
    missingResult.chat("system", "question"),
    /REST response missing configured result path "missing"/
  );

  const malformed = new LlmClient({ type: "rest", baseUrl, restBodyTpl: "not-json" });
  await assert.rejects(malformed.chat("system", "question"), /REST body template invalide/);
  const failing = new LlmClient({ type: "ollama", baseUrl });
  await assert.rejects(failing.chat("system", "question"), /LLM HTTP 502/);
  await assert.rejects(new LlmClient({ type: "unknown" }).chat("s", "u"), /Backend LLM inconnu/);
});
