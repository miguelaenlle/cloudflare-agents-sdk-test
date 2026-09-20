import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DefaultChatTransport, readUIMessageStream } from "ai";

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

  const invalidJson = await fetch(api, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(invalidJson.status, 400);
  const invalidMessages = await fetch(api, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "playground", messages: [{ role: "invalid" }] }),
  });
  assert.equal(invalidMessages.status, 400);
  const oversized = await fetch(api, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    final.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join(""),
    "Started. Finished.",
  );
  assert.ok(
    final.parts.some(
      (p) =>
        p.type === "dynamic-tool" &&
        p.toolName === "command_execution" &&
        p.state === "output-available",
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
  const fixture = "http://localhost:8791/agents/chat/playground/test";
  assert.equal(
    (await fetch(`${fixture}/sleep`, { method: "POST" })).status,
    204,
  );
  for await (const _chunk of await send()) {
  }
  const status = await (await fetch(`${fixture}/status`)).json();
  assert.deepEqual(status, {
    launches: 4,
    restores: 1,
    keepAlive: true,
    destroys: 0,
  });
  console.log(
    "Passed: cold restore resumes the native thread and keeps the sandbox warm.",
  );

  const beforeRecovery = (await history()).filter(
    (m) => m.role === "assistant",
  ).length;
  const interrupted = await firstText(await send());
  const workerExit = once(worker, "exit");
  worker.kill("SIGTERM");
  await workerExit;
  await interrupted.cancel().catch(() => {});
  startWorker();
  await ready("http://localhost:8791/agents/chat/playground/get-messages");
  let recovered;
  for (let attempt = 0; attempt < 150; attempt++) {
    recovered = await history();
    if (
      recovered
        .at(-1)
        ?.parts.some(
          (part) =>
            part.type === "text" && part.text.includes("Task interrupted."),
        )
    )
      break;
    await delay(200);
  }
  assert.equal(
    recovered.filter((message) => message.role === "assistant").length,
    beforeRecovery + 1,
  );
  assert.equal(
    recovered
      .at(-1)
      .parts.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
    "Task interrupted. It was not automatically repeated. You can send another message to continue.",
  );
  assert.deepEqual(await (await fetch(`${fixture}/status`)).json(), {
    launches: 5,
    restores: 1,
    keepAlive: true,
    destroys: 0,
  });
  console.log(
    "Passed: Worker replacement stops surviving work, saves interruption, and never repeats the prompt.",
  );
  assert.equal(
    (await fetch(`${fixture}/fail-backup`, { method: "POST" })).status,
    204,
  );
  for await (const _chunk of await send()) {
  }
  const failed = (await history()).at(-1);
  assert.ok(
    failed.parts.some(
      (part) =>
        part.type === "text" &&
        part.text.includes("Task failed: Fixture R2 unavailable"),
    ),
  );
  assert.equal(
    (await (await fetch(`${fixture}/status`)).json()).keepAlive,
    true,
  );
  console.log(
    "Passed: checkpoint failure is saved in history and keeps the sandbox warm.",
  );
  const fresh = "http://localhost:8791/agents/chat/backup-failure/test";
  assert.equal(
    (await fetch(`${fresh}/fail-backup`, { method: "POST" })).status,
    204,
  );
  const firstRun = await (
    await fetch(`${fresh}/run`, { method: "POST" })
  ).json();
  assert.equal(firstRun.run.status, "failed");
  assert.equal(firstRun.threadId, "native-thread");
  assert.equal(firstRun.checkpoint, undefined);
  const nextRun = await (
    await fetch(`${fresh}/run`, { method: "POST" })
  ).json();
  assert.equal(nextRun.run.status, "completed");
  assert.equal(nextRun.checkpoint.threadId, "native-thread");
  console.log(
    "Passed: failed first checkpoint preserves the native thread for the next warm turn.",
  );

  const failedCancelReader = await firstText(await send());
  await fetch(`${fixture}/fail-backup`, { method: "POST" });
  assert.equal((await fetch(`${api}/cancel`, { method: "POST" })).status, 204);
  let cancelFailure = "";
  while (true) {
    const { value, done } = await failedCancelReader.read();
    if (done) break;
    if (value.type === "text-delta") cancelFailure += value.delta;
  }
  assert.match(cancelFailure, /Fixture R2 unavailable/);
  assert.ok(
    (await history())
      .at(-1)
      .parts.some(
        (part) =>
          part.type === "text" && part.text.includes("Fixture R2 unavailable"),
      ),
  );
  console.log("Passed: cancellation does not hide a failed checkpoint.");

  const post = async (url, body = {}) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.ok, true);
    return response.json();
  };
  const getState = async () => (await fetch(`${fixture}/state`)).json();
  const getStatus = async () => (await fetch(`${fixture}/status`)).json();
  const advance = (milliseconds) =>
    post(`${fixture}/advance`, { milliseconds });
  const minutes = (value) => value * 60_000;
  const lease = (await getState()).sandbox;
  assert.equal(lease.phase, "waiting_for_user");
  const schedules = await (await fetch(`${fixture}/schedules`)).json();
  const lifetime = schedules.filter(
    (s) => s.payload.id === lease.id && s.payload.reason === "lifetime",
  );
  assert.equal(lifetime.length, 1);
  assert.ok(
    Math.abs(lifetime[0].time * 1000 - lease.createdAt - minutes(360)) < 1000,
  );
  await advance(minutes(9));
  assert.equal((await getStatus()).destroys, 0);
  await advance(minutes(1) + 1000);
  assert.equal((await getState()).sandbox, undefined);
  assert.equal((await getStatus()).destroys, 1);
  for await (const _chunk of await send()) {
  }
  const restored = await getState();
  assert.notEqual(restored.sandbox.id, lease.id);
  assert.equal(restored.threadId, "native-thread");
  assert.equal((await getStatus()).restores, 2);
  await post(`${fixture}/expire-old`, { id: lease.id });
  assert.equal((await getState()).sandbox.id, restored.sandbox.id);
  console.log(
    "Passed: ten minutes waiting destroys the sandbox; next turn restores; old lifetime callbacks are harmless.",
  );

  await advance(minutes(9));
  const activeReader = await firstText(await send());
  await advance(minutes(2));
  assert.equal((await getState()).sandbox.phase, "waiting_for_agent");
  assert.equal((await getStatus()).destroys, 1);
  await post(`${fixture}/stale-idle`);
  await advance(minutes(20));
  assert.equal((await getState()).run.status, "running");
  assert.equal((await getStatus()).destroys, 1);
  await fetch(`${api}/cancel`, { method: "POST" });
  while (!(await activeReader.read()).done) {}
  assert.equal(
    (await getState()).sandbox.createdAt,
    restored.sandbox.createdAt,
  );
  console.log(
    "Passed: a new turn invalidates old idle timers, can run beyond ten minutes, and does not reset sandbox age.",
  );

  await fetch(`${fixture}/fail-backup`, { method: "POST" });
  await advance(minutes(10) + 1000);
  assert.equal((await getStatus()).destroys, 1);
  assert.equal((await getState()).sandbox.phase, "waiting_for_user");
  await advance(31_000);
  assert.equal((await getState()).sandbox, undefined);
  assert.equal((await getStatus()).destroys, 2);
  console.log(
    "Passed: idle suspension does not destroy on backup failure; bounded retry can complete it.",
  );

  const deadlineReader = await firstText(await send());
  const beforeExpiry = await getState();
  const liveDeadline = await post(`${fixture}/expire`);
  assert.equal(liveDeadline.run.status, "interrupted");
  assert.equal(liveDeadline.sandbox, undefined);
  while (!(await deadlineReader.read()).done) {}
  assert.ok(
    (await history())
      .at(-1)
      .parts.some(
        (p) => p.type === "text" && p.text.includes("six-hour lifetime"),
      ),
  );
  assert.deepEqual(liveDeadline.checkpoint, beforeExpiry.checkpoint);
  for await (const _chunk of await send()) {
  }
  assert.equal((await getState()).run.status, "completed");
  console.log(
    "Passed: six-hour cap destroys during active work and restores the last checkpoint on the next message.",
  );

  await fetch(`${fixture}/ignore-cancel`, { method: "POST" });
  const stuckReader = await firstText(await send());
  const cancelResponse = await fetch(`${api}/cancel`, { method: "POST" });
  assert.equal(cancelResponse.ok, false);
  assert.equal((await getState()).run.status, "running");
  assert.equal((await fetch(`${fixture}/run`, { method: "POST" })).ok, false);
  const destroyedBeforeFailures = (await getStatus()).destroys;
  const failedSandboxId = (await getState()).sandbox.id;
  await fetch(`${fixture}/fail-destroy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attempts: 3 }),
  });
  await post(`${fixture}/expire`);
  while (!(await stuckReader.read()).done) {}
  await advance(31_000);
  await advance(31_000);
  assert.equal((await getStatus()).destroys, destroyedBeforeFailures + 3);
  assert.equal((await getStatus()).keepAlive, false);
  assert.equal((await getState()).sandbox.phase, "cleanup_failed");
  await advance(minutes(1));
  assert.equal((await getStatus()).destroys, destroyedBeforeFailures + 3);
  const remaining = await (await fetch(`${fixture}/schedules`)).json();
  assert.equal(
    remaining.filter(
      (s) => s.payload.id === failedSandboxId && s.payload.attempt,
    ).length,
    0,
  );
  await post(`${fixture}/run`);
  assert.equal((await getState()).run.status, "completed");
  console.log(
    "Passed: cleanup stops after three failures, disables keep-alive, and an explicit new message can retry and restore.",
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
