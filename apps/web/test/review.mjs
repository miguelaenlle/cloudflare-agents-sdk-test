import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DefaultChatTransport, readUIMessageStream } from "ai";
import { Chat } from "@ai-sdk/react";

const state = await mkdtemp(join(tmpdir(), "cf-relay-"));
let logs = "";
let worker;
function startWorker() {
  worker = spawn(
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
  worker.stdout.on("data", (chunk) => (logs += chunk));
  worker.stderr.on("data", (chunk) => (logs += chunk));
}
startWorker();
const api = "http://127.0.0.1:4318/api/chat";
let server;
function startServer() {
  server = spawn(
    process.execPath,
    ["--experimental-strip-types", "server/server.ts"],
    {
      env: {
        ...process.env,
        AGENT_URL: "http://localhost:8791",
        PUSH_MODE: "simulated",
        PORT: "4318",
        CHAT_DB_PATH: join(state, "chat.sqlite"),
      },
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
const diagnostics = async () => {
  const response = await fetch(`${api}/diagnostics`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
};
const history = async () => (await fetch(`${api}/history`)).json();
const transport = new DefaultChatTransport({ api });
const newMessage = (text = "Run fixture.") => ({
  id: crypto.randomUUID(),
  text,
});
const submit = async (input = newMessage()) =>
  fetch(api, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedRevision: (await (await fetch(`${api}/snapshot`)).json())
        .revision,
      ...input,
    }),
  });
async function send(input = newMessage()) {
  const response = await submit(input);
  assert.equal(response.status, 204, await response.text());
  const stream = await transport.reconnectToStream({ chatId: "playground" });
  assert.ok(stream);
  return stream;
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
  const first = await firstText(await send());
  await stopServer();
  await assert.rejects(async () => {
    while (!(await first.read()).done) {}
  });
  await delay(8500);
  startServer();
  await ready(`${api}/history`);
  const saved = await history();
  assert.ok(
    saved.some(
      (message) =>
        message.role === "assistant" &&
        message.parts.some(
          (part) => part.type === "text" && part.text.length > 0,
        ),
    ),
  );
  const stream = await send(newMessage("Continue the same conversation."));
  for await (const _ of stream) {
  }
  assert.equal(
    (await history()).filter((message) => message.role === "user").length,
    2,
  );
  console.log(
    "Passed: native-shaped streaming, durable history and detached completion across relay restart.",
  );

  const fixture = "http://localhost:8791/agents/chat/playground/test";
  assert.equal((await diagnostics()).state, "waiting_for_user");
  assert.deepEqual(await (await fetch(`${fixture}/backups`)).json(), []);
  const expired = await (
    await fetch(`${fixture}/advance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ milliseconds: 601000 }),
    })
  ).json();
  assert.equal(expired.sandbox, undefined);
  const operations = await (await fetch(`${fixture}/backups`)).json();
  assert.ok(
    operations.some(
      (event) =>
        event.type === "backup" ||
        event === "backup" ||
        event.operation === "backup",
    ),
  );
  const restored = await send(newMessage("Continue after idle restoration."));
  for await (const _ of restored) {
  }
  assert.equal((await diagnostics()).state, "waiting_for_user");
  console.log(
    "Passed: no turn-end backup, idle backup/destruction, restoration and diagnostics.",
  );

  const before = await (await fetch(`${fixture}/state`)).json();
  await fetch(`${fixture}/stale-idle`);
  assert.equal((await (await fetch(`${fixture}/state`)).json()).sandbox.id, before.sandbox.id);
  await fetch(`${fixture}/expire-old`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({id: "old-generation"})});
  assert.equal((await (await fetch(`${fixture}/state`)).json()).sandbox.id, before.sandbox.id);
  await fetch(`${fixture}/fail-backup`, {method: "POST"});
  const retained = await (await fetch(`${fixture}/advance`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({milliseconds: 601000})})).json();
  assert.equal(retained.sandbox.phase, "waiting_for_user");
  assert.equal(retained.sandbox.id, before.sandbox.id);
  await fetch(`${fixture}/fail-backup`, {method: "POST"});
  const forced = await (await fetch(`${fixture}/expire`, {method: "POST"})).json();
  assert.equal(forced.sandbox, undefined);
  console.log("Passed: stale callbacks cannot destroy a new generation; idle backup failure retains the box, deadline failure still destroys it.");


  const created = await (
    await fetch("http://localhost:4318/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Independent conversation" }),
    })
  ).json();
  const other = `http://localhost:4318/api/conversations/${created.id}/chat`;
  assert.deepEqual(
    (await (await fetch(`${other}/snapshot`)).json()).messages,
    [],
  );
  const post = (input) =>
    fetch(other, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  assert.equal(
    (
      await post({
        id: crypto.randomUUID(),
        text: "Hello",
        expectedRevision: 0,
      })
    ).status,
    204,
  );
  assert.equal(
    (
      await post({
        id: crypto.randomUUID(),
        text: "Stale tab",
        expectedRevision: 0,
      })
    ).status,
    409,
  );
  await fetch(`${other}/cancel`, { method: "POST" });
  await stopServer();
  startServer();
  await ready(`${api}/history`);
  assert.ok(
    (
      await (await fetch("http://localhost:4318/api/conversations")).json()
    ).some((c) => c.id === created.id),
  );
  console.log(
    "Passed: independent conversation history, stale revision rejection and catalog persistence.",
  );

  const steered = await firstText(
    await send(newMessage("Start a steerable turn.")),
  );
  const correction = newMessage("Use the updated instructions.");
  assert.equal((await submit(correction)).status, 204);
  assert.equal((await submit(correction)).status, 204);
  let marker = false;
  while (true) {
    const next = await steered.read();
    if (next.done) break;
    if (
      next.value.type === "data-steering" &&
      next.value.data.id === correction.id
    )
      marker = true;
  }
  assert.ok(marker);
  assert.ok(
    (await history()).some((m) =>
      m.parts.some(
        (p) => p.type === "data-steering" && p.data.id === correction.id,
      ),
    ),
  );
  console.log(
    "Passed: steering acknowledgment is interleaved and persisted without duplicate submission.",
  );
} catch (error) {
  console.error(logs.slice(-12_000));
  throw error;
} finally {
  if (server && server.exitCode === null && server.signalCode === null)
    await stopServer();
  if (worker.exitCode === null && worker.signalCode === null) {
    const exited = once(worker, "exit");
    worker.kill("SIGTERM");
    await exited;
  }
  await rm(state, { recursive: true, force: true });
}
