import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIMessageChunk } from "ai";
import { CodexEvents } from "../codex-events.ts";
import {
  checkpointCodex,
  connectCodex,
  ContainerLost,
  type CodexSandbox,
} from "../codex.ts";
import { forwardOpenAI } from "../outbound.ts";
import type { ThreadItem } from "../protocol.ts";

const text: ThreadItem = {
  type: "agentMessage",
  id: "text",
  text: "Hello world",
  phase: null,
  memoryCitation: null,
  delivery: null,
  questions: null,
};
test("deltas plus completed snapshots produce text once", () => {
  const chunks: UIMessageChunk[] = [];
  const mapper = new CodexEvents((chunk) => chunks.push(chunk), "run");
  mapper.accept({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "text",
      delta: "Hello ",
    },
  });
  mapper.item(text);
  mapper.item(text);
  mapper.finish();
  assert.equal(
    chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => c.delta)
      .join(""),
    "Hello world",
  );
  assert.equal(chunks.filter((c) => c.type === "text-start").length, 1);
  assert.equal(chunks.filter((c) => c.type === "text-end").length, 1);
});
test("unfinished tools close with an explicit error", () => {
  const chunks: UIMessageChunk[] = [];
  const mapper = new CodexEvents((chunk) => chunks.push(chunk), "run");
  mapper.item(
    { type: "fileChange", id: "file", changes: [], status: "inProgress" },
    false,
  );
  mapper.finish();
  mapper.finish();
  assert.equal(
    chunks.filter((c) => c.type === "tool-input-available").length,
    1,
  );
  assert.equal(chunks.filter((c) => c.type === "tool-output-error").length, 1);
});
test("recovery never starts or restores a missing container", async () => {
  const sandbox = {
    exists: async () => ({ exists: false }),
  } as unknown as CodexSandbox;
  await assert.rejects(
    connectCodex(sandbox, {}, { recovery: true }),
    ContainerLost,
  );
});
test("credential handler injects only into allowed OpenAI requests", async () => {
  let calls = 0;
  const send: typeof fetch = async (request) => {
    calls++;
    assert.ok(request instanceof Request);
    assert.equal(
      request.headers.get("Authorization"),
      "Bearer private-test-key",
    );
    assert.equal(request.url, "https://api.openai.com/v1/responses");
    assert.equal(request.headers.has("OpenAI-Project"), false);
    assert.equal(request.redirect, "manual");
    assert.equal(await request.text(), '{"model":"test"}');
    return new Response("stream");
  };
  const env = { CODEX_API_KEY: "private-test-key" };
  const request = new Request("http://openai.internal/v1/responses", {
    method: "POST",
    body: '{"model":"test"}',
    headers: {
      Authorization: "Bearer sandbox-controlled",
      "OpenAI-Project": "other",
    },
  });
  assert.equal(
    await (await forwardOpenAI(request, env, send)).text(),
    "stream",
  );
  for (const url of [
    "https://openai.internal/v1/responses",
    "http://openai.internal.evil.test/v1/responses",
    "http://openai.internal/v1/files",
    "http://openai.internal/v1/responses/123",
  ]) {
    assert.equal(
      (await forwardOpenAI(new Request(url, { method: "POST" }), env, send))
        .status,
      403,
    );
  }
  assert.equal(
    (
      await forwardOpenAI(
        new Request("http://openai.internal/v1/responses"),
        env,
        send,
      )
    ).status,
    403,
  );
  assert.equal(calls, 1);
});
test("missing credentials and upstream exceptions reveal no secret", async () => {
  const request = new Request("http://openai.internal/v1/responses", {
    method: "POST",
  });
  assert.equal(
    (await forwardOpenAI(request, { CODEX_API_KEY: undefined })).status,
    503,
  );
  const response = await forwardOpenAI(
    request,
    { CODEX_API_KEY: "private-test-key" },
    async () => {
      throw new Error("private-test-key");
    },
  );
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /private-test-key/);
});

test("expiry during restore prevents subsequent configuration and process launch", async () => {
  let active = true;
  const sandbox = {
    exists: async () => ({ exists: false }),
    restoreBackup: async () => {
      active = false;
    },
  } as unknown as CodexSandbox;
  await assert.rejects(
    connectCodex(
      sandbox,
      { checkpoint: { backup: { id: "backup", dir: "/workspace" } } },
      {
        assertCurrent: () => {
          if (!active) throw new Error("Expired");
        },
      },
    ),
    /Expired/,
  );
});

test("local backup uses the SDK binding path without changing production defaults", async () => {
  const calls: unknown[] = [];
  const sandbox = {
    createBackup: async (options: unknown) => {
      calls.push(options);
    },
  } as unknown as CodexSandbox;
  await checkpointCodex(sandbox);
  await checkpointCodex(sandbox, true);
  assert.deepEqual(
    calls,
    [false, true].map((localBucket) => ({
      dir: "/workspace",
      localBucket,
      ttl: 30 * 24 * 60 * 60,
      excludes: ["auth.json"],
    })),
  );
});

test("model redirects are blocked without exposing the destination", async () => {
  const response = await forwardOpenAI(
    new Request("http://openai.internal/v1/responses", { method: "POST" }),
    { CODEX_API_KEY: "private-test-key" },
    async () =>
      new Response(null, {
        status: 307,
        headers: { Location: "https://elsewhere.test" },
      }),
  );
  assert.equal(response.status, 502);
  assert.equal(response.headers.has("Location"), false);
});
