import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createCloudflareProvider } from "../server/providers/cloudflare.ts";
import { executeHostTool } from "../server/host-tools.ts";

test("relay errors are safe and invalid names never execute", async () => {
  for (const [name, input] of [
    ["host_echo", { text: 5 }],
    ["constructor", {}],
  ] as const) {
    const response = await executeHostTool({
      type: "host-tool-call",
      id: crypto.randomUUID(),
      name,
      input,
    });
    assert.equal(response.result.ok, false);
  }
});

test(
  "real Chat DO sends native calls over one of two relay watchers and returns the result",
  { timeout: 60000 },
  async () => {
    const state = await mkdtemp(join(tmpdir(), "host-tool-worker-"));
    const worker = spawn(
      "../agent/node_modules/.bin/wrangler",
      [
        "dev",
        "--config",
        "../agent/test/wrangler.jsonc",
        "--port",
        "8793",
        "--inspector-port",
        "0",
        "--persist-to",
        state,
      ],
      { stdio: "pipe", detached: true },
    );
    let logs = "";
    worker.stdout.on("data", (chunk) => {
      logs += chunk;
    });
    worker.stderr.on("data", (chunk) => {
      logs += chunk;
    });
    const origin = new URL("http://127.0.0.1:8793");
    const base = new URL("/agents/chat/host-demo", origin);
    const controller = new AbortController();
    const closes: (() => void)[] = [];
    const failures: unknown[] = [];
    const json = async (path: string) =>
      (
        await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15000) })
      ).json();
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 204, await response.text());
    };
    try {
      let ready = false;
      for (let i = 0; i < 150; i++) {
        try {
          if ((await fetch(`${base}/snapshot`)).ok) {
            ready = true;
            break;
          }
        } catch {}
        await delay(100);
      }
      assert.ok(ready, logs);
      for (let i = 0; i < 2; i++) {
        const chat = createCloudflareProvider(origin, "host-demo");
        closes.push(
          await chat.watch(
            controller.signal,
            () => {},
            () => {
              if (!controller.signal.aborted) failures.push("socket failed");
            },
          ),
        );
      }
      await post("/message", {
        id: crypto.randomUUID(),
        text: "Host demo",
        expectedRevision: 0,
      });
      await post("/test/host-tool", {
        name: "host_echo",
        input: { text: "hello over the existing socket" },
      });
      let status;
      for (let i = 0; i < 100; i++) {
        status = await json("/test/status");
        if (status.toolResults?.length) break;
        await delay(50);
      }
      assert.equal(status.toolResults.length, 1, logs);
      assert.deepEqual(status.toolResults[0], {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify({
              text: "hello over the existing socket",
              executedBy: "pl-relay",
            }),
          },
        ],
      });
      // Wait for native completion and prove the result is persisted in the existing tool UI format.
      let history;
      for (let i = 0; i < 180; i++) {
        history = await json("/get-messages");
        if (
          history.some((m: { parts: { type: string; state?: string }[] }) =>
            m.parts.some(
              (p) =>
                p.type === "tool-host_echo" && p.state === "output-available",
            ),
          )
        )
          break;
        await delay(50);
      }
      assert.ok(JSON.stringify(history).includes("pl-relay"), logs);
      assert.deepEqual(failures, []);
    } finally {
      controller.abort();
      for (const close of closes) close();
      const exited = once(worker, "exit");
      process.kill(-worker.pid!, "SIGTERM");
      await exited;
      await rm(state, { recursive: true, force: true });
    }
  },
);
