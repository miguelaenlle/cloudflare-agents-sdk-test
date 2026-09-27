import { cleanupError } from "../cleanup-error.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIMessageChunk } from "ai";
import { captureApproval } from "../approval.ts";
import { CodexEvents } from "../codex-events.ts";
import {
  checkpointCodex,
  connectCodex,
  ContainerLost,
  type CodexSandbox,
} from "../codex.ts";
import { forwardOpenAI, forwardGitHub } from "../outbound.ts";
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
test("startup explains container capacity failures without exposing raw errors", async () => {
  const sandbox = {
    exists: async () => {
      throw new Error(
        "Maximum number of running container instances exceeded. private-test-key",
      );
    },
  } as unknown as CodexSandbox;
  await assert.rejects(connectCodex(sandbox, {}), (error: Error) => {
    assert.match(error.message, /allocating the container/);
    assert.match(error.message, /running-container limit is reached/);
    assert.match(error.message, /max_instances/);
    assert.doesNotMatch(error.message, /private-test-key/);
    return true;
  });
});

test("startup identifies backup failures without exposing arbitrary SDK output", async () => {
  const sandbox = {
    exists: async () => ({ exists: false }),
    restoreBackup: async () => {
      throw new Error("private-test-key");
    },
  } as unknown as CodexSandbox;
  await assert.rejects(
    connectCodex(sandbox, {
      checkpoint: { backup: { id: "backup", dir: "/workspace" } },
    }),
    (error: Error) => {
      assert.match(error.message, /restoring the workspace backup/);
      assert.doesNotMatch(error.message, /private-test-key/);
      return true;
    },
  );
});

test("startup bounds app-server readiness and reports its timeout", async () => {
  const sandbox = {
    exists: async () => ({ exists: true }),
    getProcess: async () => ({
      status: "starting",
      waitForPort: async (port: number, options: unknown) => {
        assert.equal(port, 4500);
        assert.deepEqual(options, { path: "/readyz", timeout: 60_000 });
        throw new Error("Process timed out");
      },
    }),
  } as unknown as CodexSandbox;
  await assert.rejects(
    connectCodex(sandbox, {}),
    /readiness.*60-second limit.*timed out/,
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

test("cleanup diagnoses ignore arbitrary error text", async () => {
  const { cleanupError, OperationTimeout } =
    await import("../cleanup-error.ts");
  assert.doesNotMatch(
    cleanupError("backup", new Error("403 AccessDenied secret")),
    /secret|credentials|rejected/,
  );
  assert.match(
    cleanupError("backup", new OperationTimeout("secret")),
    /timed out/,
  );
  const rpcError = new Error("secret signed URL");
  rpcError.name = "InvalidBackupConfigError";
  assert.match(cleanupError("backup", rpcError), /configuration is invalid/);
  assert.match(
    cleanupError("stop", { code: "CONTAINER_UNAVAILABLE" }),
    /container is unavailable/,
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
      ttl: 7 * 24 * 60 * 60,
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

test("steering splits live text and reasoning without duplicating completion snapshots", () => {
  const chunks: UIMessageChunk[] = [];
  const events = new CodexEvents((chunk) => chunks.push(chunk), "r");
  events.accept({
    method: "item/agentMessage/delta",
    params: { threadId: "t", turnId: "u", itemId: "text", delta: "Hello " },
  });
  events.accept({
    method: "item/reasoning/summaryTextDelta",
    params: {
      threadId: "t",
      turnId: "u",
      itemId: "thought",
      summaryIndex: 0,
      delta: "Checking",
    },
  });
  events.steering("user-2", "Use a different approach.");
  events.item(text);
  events.finish();
  assert.equal(
    chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => c.delta)
      .join(""),
    "Hello world",
  );
  const marker = chunks.findIndex((c) => c.type === "data-steering");
  assert.ok(chunks.slice(0, marker).some((c) => c.type === "reasoning-end"));
  assert.ok(chunks.slice(marker + 1).some((c) => c.type === "text-start"));
});

test("Git credential injection only permits configured repository reads and blocks redirects", async () => {
  let calls = 0;
  const env = {
    GITHUB_TOKEN: "private-token",
  };
  const send: typeof fetch = async (input) => {
    calls++;
    assert.ok(input instanceof Request);
    assert.equal(
      input.url,
      "https://github.com/miguelaenlle/course-agent-push-sync-test.git/info/refs?service=git-upload-pack",
    );
    assert.equal(
      input.headers.get("Authorization"),
      `Basic ${btoa("x-access-token:private-token")}`,
    );
    assert.equal(input.headers.has("cookie"), false);
    return new Response("refs");
  };
  for (const scheme of ["http", "https"]) {
    assert.equal(
      (
        await forwardGitHub(
          new Request(
            `${scheme}://github.com/miguelaenlle/course-agent-push-sync-test.git/info/refs?service=git-upload-pack`,
            { headers: { cookie: "untrusted" } },
          ),
          env,
          send,
        )
      ).status,
      200,
    );
  }
  for (const url of [
    "https://github.com/other/repo.git/info/refs?service=git-upload-pack",
    "https://github.com/miguelaenlle/course-agent-push-sync-test.git/git-receive-pack",
    "https://github.com/miguelaenlle/course-agent-push-sync-test.git/info/refs?service=git-receive-pack",
    "https://github.com/miguelaenlle/course-agent-push-sync-test.git/info/refs?service=git-upload-pack&other=1",
  ]) {
    assert.equal(
      (await forwardGitHub(new Request(url), env, send)).status,
      403,
    );
  }
  assert.equal(calls, 2);
  assert.equal(
    (
      await forwardGitHub(
        new Request(
          "https://github.com/miguelaenlle/course-agent-push-sync-test.git/info/refs?service=git-upload-pack",
        ),
        env,
        async () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://evil.test" },
          }),
      )
    ).status,
    502,
  );
});

test("approval capture preserves file bytes even when exec stdout is trimmed", async () => {
  const diff = "diff --git a/a b/a\n+é  \n\\ No newline at end of file\n";
  let path = "";
  let deleted = "";
  const sandbox = {
    exec: async (command: string) => {
      path = command.match(/(\/tmp\/approval-[\w-]+\.json)/)![1]!;
      return { success: true, stdout: diff.trimEnd() };
    },
    readFile: async (requested: string) => {
      assert.equal(requested, path);
      return {
        content: JSON.stringify({
          diff,
          files: [
            {
              path: "a",
              content: "é  ",
              mode: "100644",
              previousMode: "100644",
            },
          ],
        }),
      };
    },
    deleteFile: async (requested: string) => {
      deleted = requested;
    },
  } as unknown as CodexSandbox;
  const result = await captureApproval(sandbox, {
    baseSha: "0".repeat(40),
    proposedSha: "a".repeat(40),
  });
  assert.equal(result.diff, diff);
  assert.equal(deleted, path);
  assert.match(path, /^\/tmp\/approval-[\w-]+\.json$/);
});

test("cleanup diagnostics classify failures without retaining credentials or signed URLs", () => {
  assert.match(
    cleanupError(
      "backup",
      new Error("curl: (28) Failed to connect to host?signature=secret"),
    ),
    /connect to R2/,
  );
  assert.match(
    cleanupError("backup", new Error("curl: (60) SSL certificate failure")),
    /TLS verification/,
  );
  assert.match(
    cleanupError("backup", new Error("403 AccessDenied secret")),
    /bucket permissions/,
  );
  assert.match(
    cleanupError("stop", new Error("Stop timed out")),
    /stop timed out/,
  );
  for (const stage of ["stop", "backup", "destroy"] as const)
    assert.doesNotMatch(
      cleanupError(stage, new Error("https://r2.test?signature=secret")),
      /secret|signature|https/,
    );
});

for (const name of ["BackupNotFoundError", "BackupExpiredError"]) {
  test(`${name} discards the unavailable checkpoint before fresh initialization`, async () => {
    let warning = "";
    let initialized = false;
    const sandbox = {
      exists: async () => ({ exists: false }),
      restoreBackup: async () => {
        throw Object.assign(new Error("unavailable"), { name });
      },
      exec: async () => {
        assert.match(warning, /missing or expired/);
        initialized = true;
        throw new Error("Stop before process launch");
      },
    } as unknown as CodexSandbox;
    await assert.rejects(
      connectCodex(
        sandbox,
        {
          checkpoint: {
            backup: { id: "gone", dir: "/workspace" },
            threadId: "old-thread",
          },
        },
        {
          onCheckpointUnavailable: (value) => {
            warning = value;
          },
        },
      ),
      /initializing the Git workspace/,
    );
    assert.equal(initialized, true);
    assert.match(warning, /uncommitted files and Codex session context/);
  });
}

test("transient restore failure never discards the checkpoint or initializes fresh files", async () => {
  const sandbox = {
    exists: async () => ({ exists: false }),
    restoreBackup: async () => {
      throw new Error("503 unavailable");
    },
    exec: async () => {
      assert.fail("Must preserve the existing checkpoint");
    },
  } as unknown as CodexSandbox;
  await assert.rejects(
    connectCodex(
      sandbox,
      {
        checkpoint: { backup: { id: "recoverable", dir: "/workspace" } },
      },
      { onCheckpointUnavailable: () => assert.fail("Must not discard") },
    ),
    /restoring the workspace backup/,
  );
});
