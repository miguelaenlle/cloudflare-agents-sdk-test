import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DefaultChatTransport, readUIMessageStream } from "ai";

const state = await mkdtemp(join(tmpdir(), "cf-relay-"));
const worker = spawn(
  "../agent/node_modules/.bin/wrangler",
  [
    "dev",
    "--config",
    "../agent/test/wrangler.jsonc",
    "--port",
    "8791",
    "--inspector-port",
    "0",
    "--persist-to",
    state,
  ],
  { stdio: "pipe" },
);
let logs = "";
worker.stdout.on("data", (chunk) => (logs += chunk));
worker.stderr.on("data", (chunk) => (logs += chunk));
const api = "http://127.0.0.1:4318/api/chat";
let server;
function startServer() {
  server = spawn(
    process.execPath,
    ["--experimental-strip-types", "server/server.ts"],
    {
      env: { ...process.env, AGENT_URL: "http://localhost:8791", PORT: "4318" },
      stdio: "pipe",
    },
  );
  server.stderr.on("data", (chunk) => (logs += chunk));
}
async function ready(url) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Not ready: ${url}\n${logs}`);
}
async function stopServer() {
  const exited = once(server, "exit");
  server.kill("SIGKILL");
  await exited;
}
const history = async () => (await fetch(`${api}/history`)).json();
const transport = new DefaultChatTransport({ api });
async function send() {
  return transport.sendMessages({
    chatId: "playground",
    trigger: "submit-message",
    abortSignal: undefined,
    messages: [
      ...(await history()),
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "Run fixture." }],
      },
    ],
  });
}
async function firstText(stream) {
  const reader = stream.getReader();
  while (true) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    if (value.type === "text-delta") return reader;
  }
}
try {
  await ready("http://localhost:8791/agents/chat/playground/get-messages");
  startServer();
  await ready(`${api}/history`);
  assert.deepEqual(await history(), []);
  assert.equal(
    await transport.reconnectToStream({ chatId: "playground" }),
    null,
  );

  const invalidJson = await fetch(api, { method: "POST", body: "{" });
  assert.equal(invalidJson.status, 400);
  const invalidMessages = await fetch(api, {
    method: "POST",
    body: JSON.stringify({ id: "playground", messages: [{ role: "invalid" }] }),
  });
  assert.equal(invalidMessages.status, 400);
  const oversized = await fetch(api, {
    method: "POST",
    body: "€".repeat(350_000),
  });
  assert.equal(oversized.status, 413);
  console.log(
    "Passed: malformed requests, invalid messages, and byte-based body limits.",
  );

  const first = await firstText(await send());
  await stopServer();
  await assert.rejects(async () => {
    while (!(await first.read()).done) {}
  });
  startServer();
  await ready(`${api}/history`);
  const resumed = await transport.reconnectToStream({ chatId: "playground" });
  assert.ok(resumed);
  let final;
  for await (const message of readUIMessageStream({
    stream: resumed,
    terminateOnError: true,
  }))
    final = message;
  assert.equal(
    final.parts.find((p) => p.type === "text").text,
    "Started. Finished.",
  );
  assert.ok(
    final.parts.some(
      (p) => p.type === "tool-waitOneMinute" && p.state === "output-available",
    ),
  );
  assert.equal(
    (await history()).filter((m) => m.role === "assistant").length,
    1,
  );
  console.log(
    "Passed: relay restart mid-turn, replay without duplicated text, tool result, durable history.",
  );

  const detached = await firstText(await send());
  await detached.cancel();
  await stopServer();
  await delay(9_000);
  startServer();
  await ready(`${api}/history`);
  assert.equal(
    await transport.reconnectToStream({ chatId: "playground" }),
    null,
  );
  assert.equal(
    (await history()).filter((m) => m.role === "assistant").length,
    2,
  );
  console.log("Passed: turn completes while no relay or browser is connected.");

  const cancelReader = await firstText(await send());
  const started = Date.now();
  assert.equal((await fetch(`${api}/cancel`, { method: "POST" })).status, 204);
  const chunks = [];
  while (true) {
    const next = await cancelReader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  assert.ok(Date.now() - started < 5_000);
  assert.ok(
    !chunks.some(
      (c) => c.type === "text-delta" && c.delta.includes("Finished"),
    ),
  );
  console.log(
    "Passed: explicit cancellation stops the agent independently of SSE disconnection.",
  );
} catch (error) {
  console.error(logs.slice(-12_000));
  throw error;
} finally {
  if (server && server.exitCode === null && server.signalCode === null)
    await stopServer();
  const exited = once(worker, "exit");
  worker.kill("SIGTERM");
  await exited;
  await rm(state, { recursive: true, force: true });
}
