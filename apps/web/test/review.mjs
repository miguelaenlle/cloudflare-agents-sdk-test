import { createCloudflareProvider } from "../server/providers/cloudflare.ts";
import pg from "pg";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DefaultChatTransport, readUIMessageStream } from "ai";
import { Chat } from "@ai-sdk/react";

const schema = `test_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = new pg.Client({
  connectionString:
    process.env.DATABASE_URL ?? "postgresql://localhost/course_agent",
});
await admin.connect();
await admin.query(`CREATE SCHEMA ${schema}`);
const databaseUrl = new URL(
  process.env.DATABASE_URL ?? "postgresql://localhost/course_agent",
);
databaseUrl.searchParams.set("options", `-c search_path=${schema}`);
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
        DATABASE_URL: databaseUrl.toString(),
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
  const firstCheckpointId = expired.checkpoint.backup.id;
  const restored = await send(newMessage("Continue after idle restoration."));
  for await (const _ of restored) {
  }
  assert.equal((await diagnostics()).state, "waiting_for_user");
  console.log(
    "Passed: no turn-end backup, idle backup/destruction, restoration and diagnostics.",
  );

  const before = await (await fetch(`${fixture}/state`)).json();
  await fetch(`${fixture}/stale-idle`);
  assert.equal(
    (await (await fetch(`${fixture}/state`)).json()).sandbox.id,
    before.sandbox.id,
  );
  await fetch(`${fixture}/expire-old`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "old-generation" }),
  });
  assert.equal(
    (await (await fetch(`${fixture}/state`)).json()).sandbox.id,
    before.sandbox.id,
  );
  await fetch(`${fixture}/fail-backup`, { method: "POST" });
  const retained = await (
    await fetch(`${fixture}/advance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ milliseconds: 601000 }),
    })
  ).json();
  assert.equal(retained.sandbox.phase, "waiting_for_user");
  assert.equal(retained.sandbox.id, before.sandbox.id);
  assert.equal(retained.checkpoint.backup.id, firstCheckpointId);
  const beforeReplacement = await (
    await fetch(`${fixture}/backup-objects`)
  ).json();
  assert.ok(
    beforeReplacement.includes(`backups/${firstCheckpointId}/data.sqsh`),
  );
  const failedDiagnostics = await diagnostics();
  assert.equal(failedDiagnostics.cleanup.stage, "backup");
  assert.equal(failedDiagnostics.cleanup.attempts, 1);
  assert.match(failedDiagnostics.cleanup.error, /backup failed/);
  assert.ok(failedDiagnostics.cleanup.retryAt);
  // Exhaust automatic retries using the fixture clock, then recover via the public relay endpoint.
  for (let attempt = 2; attempt <= 3; attempt++) {
    await fetch(`${fixture}/fail-backup`, { method: "POST" });
    await fetch(`${fixture}/advance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ milliseconds: 31_000 }),
    });
    assert.equal((await diagnostics()).cleanup.attempts, attempt);
  }
  assert.equal((await diagnostics()).cleanup.retryAt, null);
  await fetch(`${fixture}/fail-destroy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attempts: 1 }),
  });
  assert.equal((await fetch(`${api}/cleanup`, { method: "POST" })).status, 202);
  for (
    let i = 0;
    i < 100 && (await diagnostics()).state !== "cleanup_failed";
    i++
  )
    await delay(100);
  assert.equal((await diagnostics()).state, "cleanup_failed");
  const rejectedBefore = await (await fetch(`${api}/snapshot`)).json();
  assert.equal(
    (await submit(newMessage("Must not be persisted during cleanup"))).status,
    409,
  );
  assert.deepEqual(
    (await (await fetch(`${api}/snapshot`)).json()).messages,
    rejectedBefore.messages,
  );
  const unconfirmed = await (await fetch(`${fixture}/state`)).json();
  assert.notEqual(unconfirmed.checkpoint.backup.id, firstCheckpointId);
  assert.deepEqual(
    (await (await fetch(`${fixture}/backup-objects`)).json()).sort(),
    [
      `backups/${firstCheckpointId}/data.sqsh`,
      `backups/${firstCheckpointId}/meta.json`,
      `backups/${unconfirmed.checkpoint.backup.id}/data.sqsh`,
      `backups/${unconfirmed.checkpoint.backup.id}/meta.json`,
    ].sort(),
  );
  assert.equal((await fetch(`${api}/cleanup`, { method: "POST" })).status, 202);
  for (let i = 0; i < 100 && (await diagnostics()).state !== "absent"; i++)
    await delay(100);
  assert.equal((await diagnostics()).state, "absent");
  assert.equal((await diagnostics()).cleanup, undefined);
  const replacement = await (await fetch(`${fixture}/state`)).json();
  assert.notEqual(replacement.checkpoint.backup.id, firstCheckpointId);
  for (let i = 0; i < 50; i++) {
    const keys = await (await fetch(`${fixture}/backup-objects`)).json();
    if (keys.length === 2) break;
    await delay(100);
  }
  assert.deepEqual(
    (await (await fetch(`${fixture}/backup-objects`)).json()).sort(),
    [
      `backups/${replacement.checkpoint.backup.id}/data.sqsh`,
      `backups/${replacement.checkpoint.backup.id}/meta.json`,
    ],
  );
  assert.equal((await fetch(`${api}/cleanup`, { method: "POST" })).status, 409);
  const afterRetry = await send(newMessage("Continue after cleanup retry."));
  for await (const _ of afterRetry) {
  }
  assert.equal((await diagnostics()).state, "waiting_for_user");

  await fetch(`${fixture}/fail-backup`, { method: "POST" });
  const forced = await (
    await fetch(`${fixture}/expire`, { method: "POST" })
  ).json();
  assert.equal(forced.sandbox, undefined);
  assert.match(
    (await diagnostics()).checkpointError,
    /Final checkpoint unavailable/,
  );
  console.log(
    "Passed: stale callbacks cannot destroy a new generation; idle backup failure retains the box, deadline failure still destroys it.",
  );

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

  const postJson = (url, input = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(35_000),
    });
  const native = "http://localhost:8791/agents/chat/review-regressions";
  await postJson(`${native}/test/legacy-approval-lock`);
  assert.equal(
    (await (await fetch(`${native}/snapshot`)).json()).blocked,
    false,
  );
  await postJson(`${native}/test/drop-start-ack`);
  const lostId = crypto.randomUUID();
  assert.equal(
    (
      await postJson(`${native}/message`, {
        id: lostId,
        text: "Lost acknowledgment",
        expectedRevision: 0,
      })
    ).ok,
    false,
  );
  assert.equal(
    (await (await fetch(`${native}/test/state`)).json()).run.turnId,
    undefined,
  );
  await delay(8500);
  assert.equal((await postJson(`${native}/test/recover`)).ok, true);
  const recovered = await (await fetch(`${native}/test/state`)).json();
  assert.equal(recovered.run.status, "completed");
  assert.equal(recovered.run.accepted, true);
  assert.equal((await (await fetch(`${native}/test/status`)).json()).turns, 1);
  console.log(
    "Passed: lost start reply and notification recover by client message ID without replay; legacy capture lock is ignored.",
  );

  const rev = (await (await fetch(`${native}/snapshot`)).json()).revision;
  assert.equal(
    (
      await postJson(`${native}/message`, {
        id: crypto.randomUUID(),
        text: "Prepare a proposal",
        expectedRevision: rev,
      })
    ).status,
    204,
  );
  await postJson(`${native}/test/approval`);
  let pending;
  for (let i = 0; i < 50; i++) {
    pending = await (await fetch(`${native}/snapshot`)).json();
    if (pending.pendingTool) break;
    await delay(100);
  }
  await postJson(`${native}/test/advance`, { milliseconds: 16000 });
  await postJson(`${native}/test/advance`, { milliseconds: 601000 });
  await postJson(`${native}/test/launch`, { failLaunch: true });
  const decision = {
    id: pending.pendingTool.id,
    digest: pending.pendingTool.args.digest,
    approved: true,
    expectedRevision: pending.revision,
    result: "Simulated publication result",
  };
  const resultProvider = createCloudflareProvider(
    new URL("http://127.0.0.1:8791"),
    "review-regressions",
  );
  await assert.rejects(
    resultProvider.deliverToolResult(decision, AbortSignal.timeout(30000)),
    /delivery failed/,
  );
  let failed = await (await fetch(`${native}/test/state`)).json();
  assert.equal(failed.pendingTool.id, decision.id);
  assert.equal(failed.run.accepted, undefined);
  await delay(100);
  await resultProvider.deliverToolResult(decision, AbortSignal.timeout(30000));
  const delivered = await (await fetch(`${native}/test/state`)).json();
  assert.equal(delivered.pendingTool, undefined);
  assert.equal(delivered.run.accepted, true);
  const deliveredHistory = await (await fetch(`${native}/snapshot`)).json();
  assert.equal(
    deliveredHistory.messages.filter((m) => m.id === decision.id).length,
    1,
  );
  await postJson(`${native}/cancel`);
  console.log(
    "Passed: failed cold approval submission retries native execution instead of deduplicating on UI history.",
  );

  await postJson(`${native}/test/advance`, { milliseconds: 601000 });
  await postJson(`${native}/test/delete-checkpoint`);
  const afterDeletion = await (await fetch(`${native}/snapshot`)).json();
  const fresh = await postJson(`${native}/message`, {
    id: crypto.randomUUID(),
    text: "Start after backup loss",
    expectedRevision: afterDeletion.revision,
  });
  assert.equal(fresh.status, 204, await fresh.text());
  const freshState = await (await fetch(`${native}/test/state`)).json();
  assert.equal(freshState.checkpoint, undefined);
  assert.match(freshState.lastCheckpointError, /missing or expired/);
  await postJson(`${native}/cancel`);
  console.log(
    "Passed: a missing R2 archive is identified across DO RPC and starts fresh with a retained warning.",
  );

  const rpcFailure = await (
    await fetch("http://localhost:8791/agents/chat/playground/test/error-shape")
  ).json();
  assert.equal(rpcFailure.name, "InvalidBackupConfigError");
  assert.match(rpcFailure.diagnosis, /configuration is invalid/);
  assert.doesNotMatch(JSON.stringify(rpcFailure), /signed-url-secret/);

  const slow = "http://localhost:8791/agents/chat/slow-start-review";
  await postJson(`${slow}/test/launch`, { launchDelay: 28000 });
  assert.equal(
    (
      await postJson(`${slow}/message`, {
        id: crypto.randomUUID(),
        text: "Slow startup",
        expectedRevision: 0,
      })
    ).ok,
    false,
  );
  const beforeSecond = await (await fetch(`${slow}/snapshot`)).json();
  const started = Date.now();
  const rejected = await postJson(`${slow}/message`, {
    id: crypto.randomUUID(),
    text: "Not yet",
    expectedRevision: beforeSecond.revision,
  });
  assert.equal(rejected.status, 409);
  assert.match(await rejected.text(), /still starting/);
  await postJson(`${slow}/cancel`);
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(
    await (await fetch(`${slow}/snapshot`)).json(),
    beforeSecond,
  );
  await delay(4000);
  const stoppedStartup = await (await fetch(`${slow}/test/status`)).json();
  assert.equal(stoppedStartup.turns, 0);
  assert.equal(stoppedStartup.destroys, 1);
  assert.equal(
    (await (await fetch(`${slow}/diagnostics`)).json()).state,
    "absent",
  );
  console.log(
    "Passed: Send during startup rejects promptly without persisting input or blocking Stop behind the model turn.",
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
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
