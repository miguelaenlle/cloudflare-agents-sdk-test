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
  if (!process.env.FEATURES_ONLY) {
    assert.deepEqual(await history(), []);
    assert.deepEqual(await diagnostics(), {
      state: "absent",
      idleExpiresAt: null,
      interactionExpiresAt: null,
    });
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
      body: JSON.stringify({
        id: "playground",
        messages: [{ role: "invalid" }],
      }),
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
    const fixture = "http://localhost:8791/agents/chat/playground/test";
    const steering = newMessage("Please also explain the result.");
    assert.equal((await submit(steering)).status, 204);
    assert.equal((await submit(steering)).status, 204);
    assert.equal((await (await fetch(`${fixture}/status`)).json()).steers, 1);
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
    console.log(
      "Passed: turn completes while no relay or browser is connected.",
    );

    const cancelReader = await firstText(await send());
    const started = Date.now();
    assert.equal(
      (await fetch(`${api}/cancel`, { method: "POST" })).status,
      204,
    );
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
    assert.deepEqual(await (await fetch(`${fixture}/backups`)).json(), []);
    assert.equal(
      (await fetch(`${fixture}/sleep`, { method: "POST" })).status,
      204,
    );
    for await (const _chunk of await send()) {
    }
    const status = await (await fetch(`${fixture}/status`)).json();
    assert.deepEqual(status, {
      launches: 2,
      restores: 0,
      running: true,
      destroys: 0,
      steers: 1,
      turns: 4,
    });
    console.log(
      "Passed: unexpected loss before the first shutdown backup starts a fresh workspace.",
    );

    assert.ok((await history()).some((message) => message.id === steering.id));
    console.log(
      "Passed: accepted steering is durable and idempotent at the PL request boundary.",
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
      launches: 2,
      restores: 0,
      running: true,
      destroys: 0,
      steers: 1,
      turns: 5,
    });
    console.log(
      "Passed: Worker replacement stops surviving work, saves interruption, and never repeats the prompt.",
    );
    assert.deepEqual(await (await fetch(`${fixture}/backups`)).json(), []);
    console.log(
      "Passed: completion, steering, Stop, and recovery do not create backups.",
    );

    const beforeUncertain = await (await fetch(`${fixture}/status`)).json();
    await fetch(`${fixture}/drop-start-ack`, { method: "POST" });
    assert.equal((await submit()).ok, false);
    assert.equal(
      (await (await fetch(`${fixture}/state`)).json()).run.status,
      "running",
    );
    assert.equal(
      (await fetch(`${fixture}/recover`, { method: "POST" })).ok,
      true,
    );
    const afterUncertain = await (await fetch(`${fixture}/status`)).json();
    assert.equal(afterUncertain.turns, beforeUncertain.turns + 1);
    assert.equal(afterUncertain.launches, beforeUncertain.launches);
    assert.equal(
      (await (await fetch(`${fixture}/state`)).json()).run.status,
      "interrupted",
    );
    console.log(
      "Passed: lost turn/start acknowledgment is reconciled without replay or process replacement.",
    );

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
    assert.deepEqual(await diagnostics(), {
      state: lease.phase,
      idleExpiresAt: lease.waitingSince + minutes(10),
      interactionExpiresAt: lease.lastUserInteractionAt + minutes(360),
    });
    assert.deepEqual((await getState()).sandbox, lease);
    const schedules = await (await fetch(`${fixture}/schedules`)).json();
    const lifetime = schedules.filter(
      (s) => s.payload.id === lease.id && s.payload.reason === "interaction",
    );
    assert.equal(lifetime.length, 1);
    assert.ok(
      Math.abs(
        lifetime[0].time * 1000 - lease.lastUserInteractionAt - minutes(360),
      ) < 1000,
    );
    await advance(minutes(9));
    assert.equal((await getStatus()).destroys, 0);
    await advance(minutes(1) + 1000);
    assert.equal((await getState()).sandbox, undefined);
    assert.equal((await getStatus()).destroys, 1);
    assert.deepEqual(await diagnostics(), {
      state: "absent",
      idleExpiresAt: null,
      interactionExpiresAt: null,
    });
    assert.deepEqual(await (await fetch(`${fixture}/backups`)).json(), [
      "backup",
      "destroy",
    ]);
    for await (const _chunk of await send()) {
    }
    const restored = await getState();
    assert.notEqual(restored.sandbox.id, lease.id);
    assert.equal(restored.threadId, "native-thread");
    assert.equal((await getStatus()).restores, 1);
    await post(`${fixture}/expire-old`, { id: lease.id });
    assert.equal((await getState()).sandbox.id, restored.sandbox.id);
    console.log(
      "Passed: ten minutes waiting destroys the sandbox; next turn restores; old lifetime callbacks are harmless.",
    );

    await advance(minutes(9));
    const activeReader = await firstText(await send());
    await advance(minutes(2));
    assert.equal((await getState()).sandbox.phase, "waiting_for_agent");
    assert.equal((await diagnostics()).idleExpiresAt, null);
    assert.equal((await getStatus()).destroys, 1);
    await post(`${fixture}/stale-idle`);
    await advance(minutes(20));
    assert.equal((await getState()).run.status, "running");
    assert.equal((await getStatus()).destroys, 1);
    await advance(minutes(300));
    const beforeSteer = (await getState()).sandbox.lastUserInteractionAt;
    assert.equal(
      (await submit({ id: crypto.randomUUID(), text: "" })).status,
      400,
    );
    assert.equal((await getState()).sandbox.lastUserInteractionAt, beforeSteer);
    assert.equal((await submit(newMessage("Keep working."))).status, 204);
    await advance(minutes(61));
    assert.equal((await getState()).sandbox.id, restored.sandbox.id);
    assert.equal((await getState()).run.status, "running");
    await fetch(`${api}/cancel`, { method: "POST" });
    while (!(await activeReader.read()).done) {}
    assert.ok(
      (await getState()).sandbox.lastUserInteractionAt >
        restored.sandbox.lastUserInteractionAt,
    );
    console.log(
      "Passed: a new turn invalidates old idle timers, can run beyond the idle timeout, and refreshes the interaction deadline.",
    );

    const beforeIdleFailure = await (await fetch(`${fixture}/backups`)).json();
    await fetch(`${fixture}/fail-backup`, { method: "POST" });
    await advance(minutes(10) + 1000);
    assert.equal((await getStatus()).destroys, 1);
    assert.equal((await getState()).sandbox.phase, "waiting_for_user");
    await advance(31_000);
    assert.equal((await getState()).sandbox, undefined);
    assert.equal((await getStatus()).destroys, 2);
    assert.deepEqual(await (await fetch(`${fixture}/backups`)).json(), [
      ...beforeIdleFailure,
      "backup-failed",
      "backup",
      "destroy",
    ]);
    console.log(
      "Passed: idle suspension does not destroy on backup failure; bounded retry can complete it.",
    );

    const deadlineReader = await firstText(await send());
    const backupsBeforeExpiry = await (
      await fetch(`${fixture}/backups`)
    ).json();
    const liveDeadline = await post(`${fixture}/expire`);
    assert.equal(liveDeadline.run.status, "interrupted");
    assert.equal(liveDeadline.sandbox, undefined);
    while (!(await deadlineReader.read()).done) {}
    assert.ok(
      (await history())
        .at(-1)
        .parts.some(
          (p) =>
            p.type === "text" &&
            p.text.includes("User interaction deadline reached"),
        ),
    );
    assert.equal(liveDeadline.checkpoint.threadId, "native-thread");
    assert.deepEqual(await (await fetch(`${fixture}/backups`)).json(), [
      ...backupsBeforeExpiry,
      "backup",
      "destroy",
    ]);
    for await (const _chunk of await send()) {
    }
    assert.equal((await getState()).run.status, "completed");
    console.log(
      "Passed: six-hour interaction deadline destroys during active work and restores the last checkpoint on the next message.",
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
    assert.equal((await getStatus()).running, true);
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
      "Passed: cleanup stops after three failures, retains the sandbox identity, and an explicit new message can retry and restore.",
    );
    const idleDeadline = "http://localhost:8791/agents/chat/idle-deadline/test";
    const firstRun = await post(`${idleDeadline}/run`);
    assert.equal(firstRun.run.status, "completed");
    assert.equal(firstRun.checkpoint, undefined);
    const idleExpired = await post(`${idleDeadline}/expire`);
    assert.equal(idleExpired.sandbox, undefined);
    assert.equal(idleExpired.checkpoint.threadId, "native-thread");
    assert.deepEqual(await (await fetch(`${idleDeadline}/backups`)).json(), [
      "backup",
      "destroy",
    ]);
    console.log(
      "Passed: deadline cleanup backs up an idle sandbox before destroying it.",
    );

    const backupFailure =
      "http://localhost:8791/agents/chat/backup-failure/test";
    await fetch(`${backupFailure}/fail-backup`, { method: "POST" });
    const warmRun = await post(`${backupFailure}/run`);
    assert.equal(warmRun.run.status, "completed");
    assert.equal(warmRun.checkpoint, undefined);
    assert.deepEqual(
      await (await fetch(`${backupFailure}/backups`)).json(),
      [],
    );
    const expiredWithoutBackup = await post(`${backupFailure}/expire`);
    assert.equal(expiredWithoutBackup.sandbox, undefined);
    assert.equal(expiredWithoutBackup.checkpoint, undefined);
    assert.deepEqual(await (await fetch(`${backupFailure}/backups`)).json(), [
      "backup-failed",
      "destroy",
    ]);
    console.log(
      "Passed: unavailable backups do not fail a turn, and deadline cleanup still destroys the sandbox.",
    );

    const shortDeadline =
      "http://localhost:8791/agents/chat/short-deadline/test";
    await post(`${shortDeadline}/run`);
    const beforeDeadline = await post(`${shortDeadline}/advance`, {
      milliseconds: 20_000,
    });
    assert.equal(beforeDeadline.sandbox.phase, "waiting_for_user");
    const afterDeadline = await post(`${shortDeadline}/advance`, {
      milliseconds: 11_000,
    });
    assert.equal(afterDeadline.sandbox, undefined);
    assert.deepEqual(await (await fetch(`${shortDeadline}/backups`)).json(), [
      "backup",
      "destroy",
    ]);
    console.log(
      "Passed: test-only 30-second interaction deadline expires before the ten-minute idle timer.",
    );

    const chat = new Chat({
      id: "playground",
      transport,
      messages: await history(),
    });
    const uiBefore = await getStatus();
    const initialMessage = newMessage("UI first message.");
    assert.equal((await submit(initialMessage)).status, 204);
    chat.messages = await history();
    const firstAttachment = chat.resumeStream();
    for (let i = 0; i < 100 && chat.status !== "streaming"; i++)
      await delay(20);
    assert.equal(chat.status, "streaming");
    await chat.stop();
    const correction = newMessage("UI correction while working.");
    assert.equal((await submit(correction)).status, 204);
    chat.messages = await history();
    await chat.resumeStream();
    await firstAttachment;
    assert.equal(chat.status, "ready");
    assert.equal((await getStatus()).turns, uiBefore.turns + 1);
    assert.equal((await getStatus()).steers, uiBefore.steers + 1);
    assert.equal(chat.messages.filter((m) => m.id === correction.id).length, 1);
    assert.equal(
      chat.messages
        .at(-1)
        .parts.filter((p) => p.type === "text")
        .map((p) => p.text)
        .join(""),
      "Started. Finished.",
    );
    console.log(
      "Passed: AI SDK stop/history/resume preserves one response when Send steers an active turn.",
    );

    // Both outcomes use the same public POST, with no run ID or client-side busy decision.
    const raceReader = await firstText(await send());
    const beforeRace = await getStatus();
    await post(`${fixture}/steer-behavior`, { behavior: "finish" });
    const racedMessage = newMessage("Continue after the turn finished.");
    assert.equal((await submit(racedMessage)).status, 204);
    while (!(await raceReader.read()).done) {}
    assert.equal((await getStatus()).turns, beforeRace.turns + 1);
    assert.equal((await getStatus()).steers, beforeRace.steers);
    assert.equal((await submit(racedMessage)).status, 204);
    assert.equal((await getStatus()).turns, beforeRace.turns + 1);
    const raceStream = await transport.reconnectToStream({
      chatId: "playground",
    });
    for await (const _chunk of raceStream) {
    }
    assert.equal(
      (await history()).filter((m) => m.id === racedMessage.id).length,
      1,
    );
    console.log(
      "Passed: rejected steering after turn completion starts once; duplicate submission does not rerun it.",
    );

    const rejectedReader = await firstText(await send());
    const beforeRejected = await getStatus();
    await post(`${fixture}/steer-behavior`, { behavior: "reject" });
    assert.equal((await submit(newMessage("Rejected correction."))).ok, false);
    assert.equal((await getStatus()).turns, beforeRejected.turns);
    assert.equal((await getStatus()).steers, beforeRejected.steers);
    await fetch(`${api}/cancel`, { method: "POST" });
    while (!(await rejectedReader.read()).done) {}
    console.log(
      "Passed: an unrelated RPC rejection during active work does not start a second turn.",
    );

    const uncertainReader = await firstText(await send());
    const beforeLostSteer = await getStatus();
    await post(`${fixture}/steer-behavior`, { behavior: "lose-ack" });
    assert.equal(
      (await submit(newMessage("Accepted but acknowledgment lost."))).ok,
      false,
    );
    while (!(await uncertainReader.read()).done) {}
    assert.equal((await getStatus()).turns, beforeLostSteer.turns);
    assert.equal((await getStatus()).steers, beforeLostSteer.steers + 1);
    await post(`${fixture}/recover`);
    assert.equal((await getStatus()).turns, beforeLostSteer.turns);
    console.log(
      "Passed: uncertain steering is never automatically resubmitted as a new turn.",
    );
  }

  // CAS checks operate on accepted user actions, not the number of streamed chunks.
  await fetch(`${api}/cancel`, { method: "POST" });
  const old = await (await fetch(`${api}/snapshot`)).json();
  assert.equal(
    (await submit({ ...newMessage("Fresh"), expectedRevision: old.revision }))
      .status,
    204,
  );
  const stale = await submit({
    ...newMessage("Stale"),
    expectedRevision: old.revision,
  });
  assert.equal(stale.status, 409);
  assert.match(await stale.text(), /another tab/);
  await fetch(`${api}/cancel`, { method: "POST" });
  await delay(300);
  const catalog = "http://127.0.0.1:4318/api/conversations";
  const created = await (
    await fetch(catalog, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Independent conversation" }),
    })
  ).json();
  const other = await (
    await fetch(`${catalog}/${created.id}/chat/snapshot`)
  ).json();
  assert.deepEqual(other.messages, []);
  assert.equal(other.revision, 0);
  console.log("Passed: stale sends rejected and conversations isolated.");

  await submit(newMessage("Prepare approval"));
  await fetch("http://127.0.0.1:8791/agents/chat/playground/test/approval", {
    method: "POST",
  });
  let approvalSnapshot;
  for (let i = 0; i < 50; i++) {
    approvalSnapshot = await (await fetch(`${api}/snapshot`)).json();
    if (approvalSnapshot.approval?.status === "pending") break;
    await delay(100);
  }
  assert.equal(approvalSnapshot.approval.status, "pending");
  assert.equal((await diagnostics()).state, "waiting_for_user");
  assert.equal((await submit(newMessage("Must be blocked"))).status, 409);
  const expiration = await (
    await fetch("http://127.0.0.1:8791/agents/chat/playground/test/advance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ milliseconds: 10 * 60_000 + 1000 }),
    })
  ).json();
  assert.equal(expiration.sandbox, undefined, JSON.stringify(expiration));
  const suspended = await (await fetch(`${api}/snapshot`)).json();
  assert.deepEqual(suspended.approval, approvalSnapshot.approval);
  const decision = {
    id: suspended.approval.id,
    digest: suspended.approval.digest,
    expectedRevision: suspended.revision,
    approved: true,
  };
  const approve = () =>
    fetch(`${api}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(decision),
    });
  const approved = await approve();
  assert.equal(approved.status, 204, await approved.text());
  assert.equal((await approve()).status, 204);
  const after = await (await fetch(`${api}/snapshot`)).json();
  assert.equal(after.approval.status, "approved");
  assert.equal(after.messages.filter((m) => m.id === decision.id).length, 1);
  assert.ok(
    after.messages.some((m) =>
      m.parts.some(
        (p) => p.type === "text" && p.text.includes("SIMULATION ONLY"),
      ),
    ),
  );
  await fetch(`${api}/cancel`, { method: "POST" });
  console.log(
    "Passed: approval survives idle backup/destruction, restores and delivers an idempotent simulated result.",
  );

  const otherApi = `${catalog}/${created.id}/chat`;
  async function postJson(url, input) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  assert.equal(
    (
      await postJson(otherApi, {
        ...newMessage("Warm approval"),
        expectedRevision: 0,
      })
    ).status,
    204,
  );
  await fetch(`http://127.0.0.1:8791/agents/chat/${created.id}/test/approval`, {
    method: "POST",
  });
  let warm;
  for (let i = 0; i < 50; i++) {
    warm = await (await fetch(`${otherApi}/snapshot`)).json();
    if (warm.approval) break;
    await delay(100);
  }
  const deny = {
    id: warm.approval.id,
    digest: warm.approval.digest,
    expectedRevision: warm.revision,
    approved: false,
  };
  assert.equal(
    (await postJson(`${otherApi}/approval`, { ...deny, digest: "changed" }))
      .status,
    409,
  );
  await stopServer();
  startServer();
  await ready(`${api}/history`);
  assert.equal((await postJson(`${otherApi}/approval`, deny)).status, 204);
  assert.equal(
    (await postJson(`${otherApi}/approval`, { ...deny, approved: true }))
      .status,
    409,
  );
  const warmAfter = await (await fetch(`${otherApi}/snapshot`)).json();
  assert.equal(warmAfter.approval.status, "denied");
  assert.equal(
    warmAfter.messages.some((m) => m.id === deny.id),
    false,
  );
  const sandbox = await (
    await fetch(`http://127.0.0.1:8791/agents/chat/${created.id}/test/status`)
  ).json();
  assert.ok(JSON.stringify(sandbox.toolResults).includes("user denied"));
  await fetch(`${otherApi}/cancel`, { method: "POST" });
  console.log(
    "Passed: warm denial is a native tool result, relay restart retains catalog, tampered/conflicting decisions are rejected.",
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
