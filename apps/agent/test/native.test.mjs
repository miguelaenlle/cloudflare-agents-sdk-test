import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pushSyncTool } from "../approval.ts";
import { AppServer, within } from "../app-server.ts";

// Real pinned Codex, fake model endpoint: no OpenAI credentials or paid inference.
test(
  "native app-server streams, steers, interrupts, and survives socket replacement",
  { timeout: 60_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "cf-native-"));
    let requests = 0;
    let toolMode = false;
    let toolIssued = false;
    let toolInput;
    const model = createServer(async (request, response) => {
      if (request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      assert.equal(request.headers.authorization, undefined);
      let body = "";
      for await (const chunk of request) body += chunk;
      if (toolMode) toolInput = JSON.parse(body);
      requests++;
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      const send = (type, payload) =>
        response.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`,
        );
      const item = {
        type: "message",
        id: "msg_test",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "Hello from the fake model.",
            annotations: [],
          },
        ],
      };
      send("response.created", {
        response: { id: `resp_${requests}`, status: "in_progress", output: [] },
      });
      if (toolMode && !toolIssued) {
        toolIssued = true;
        const call = {
          type: "function_call",
          id: "fc_test",
          call_id: "call_test",
          name: "push_sync",
          arguments: JSON.stringify({
            baseSha: "a".repeat(40),
            proposedSha: "b".repeat(40),
          }),
          status: "completed",
        };
        send("response.output_item.added", { output_index: 0, item: call });
        send("response.output_item.done", { output_index: 0, item: call });
        send("response.completed", {
          response: {
            id: `resp_${requests}`,
            status: "completed",
            output: [call],
            usage: { input_tokens: 10, output_tokens: 6, total_tokens: 16 },
          },
        });
        response.end();
        return;
      }
      if (requests > 1 && !toolMode) return; // Hold generation open for steering and Stop.
      send("response.output_item.added", {
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      });
      send("response.content_part.added", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      send("response.output_text.delta", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: "Hello from the fake model.",
      });
      send("response.output_text.done", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text: "Hello from the fake model.",
      });
      send("response.output_item.done", { output_index: 0, item });
      send("response.completed", {
        response: {
          id: "resp_1",
          status: "completed",
          output: [item],
          usage: { input_tokens: 10, output_tokens: 6, total_tokens: 16 },
        },
      });
      response.end();
    });
    await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
    const portReservation = createServer();
    await new Promise((resolve) =>
      portReservation.listen(0, "127.0.0.1", resolve),
    );
    const port = portReservation.address().port;
    await new Promise((resolve) => portReservation.close(resolve));
    const config = (
      await readFile(new URL("../codex-config.toml", import.meta.url), "utf8")
    )
      .replace("/tmp/codex-logs", join(home, "logs"))
      .replace(
        "http://openai.internal/v1",
        `http://127.0.0.1:${model.address().port}/v1`,
      );
    await writeFile(join(home, "config.toml"), config);
    const command = process.env.CODEX_BINARY ?? process.execPath;
    const args = process.env.CODEX_BINARY
      ? []
      : [
          new URL("../node_modules/@openai/codex/bin/codex.js", import.meta.url)
            .pathname,
        ];
    const child = spawn(
      command,
      [...args, "app-server", "--listen", `ws://127.0.0.1:${port}`],
      {
        env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let logs = "";
    child.stderr.on("data", (data) => {
      logs += data;
    });
    child.stdout.resume();
    let client;
    async function connect() {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      await once(socket, "open");
      const connected = new AppServer(socket);
      await connected.initialize();
      return connected;
    }
    function completed() {
      return within(
        new Promise((resolve) => {
          const unsubscribe = client.subscribe((event) => {
            if (event.method === "turn/completed") {
              unsubscribe();
              resolve(event.params.turn);
            }
          });
        }),
        15_000,
        "Native turn did not complete",
      );
    }
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) throw new Error(logs);
        try {
          if ((await fetch(`http://127.0.0.1:${port}/readyz`)).ok) break;
        } catch {}
        await delay(100);
      }
      client = await connect();
      const { thread } = await client.request("thread/start", {
        cwd: home,
        model: "gpt-5.4",
        approvalPolicy: "never",
        sandbox: "workspace-write",
      });
      const notifications = [];
      client.subscribe((event) => notifications.push(event));
      const first = completed();
      await client.request("turn/start", {
        threadId: thread.id,
        clientUserMessageId: crypto.randomUUID(),
        input: [{ type: "text", text: "Say hello.", text_elements: [] }],
      });
      const result = await first;
      assert.equal(result.status, "completed", JSON.stringify(result));
      assert.ok(
        notifications.some(
          (event) => event.method === "item/agentMessage/delta",
        ),
      );
      client.close();
      assert.equal(child.exitCode, null);
      client = await connect();
      const resumed = await client.request("thread/resume", {
        threadId: thread.id,
      });
      assert.equal(resumed.thread.id, thread.id);
      assert.ok(
        resumed.thread.turns[0].items.some(
          (item) =>
            item.type === "agentMessage" &&
            item.text === "Hello from the fake model.",
        ),
      );
      const second = completed();
      const { turn } = await client.request("turn/start", {
        threadId: thread.id,
        clientUserMessageId: crypto.randomUUID(),
        input: [
          { type: "text", text: "Think for a while.", text_elements: [] },
        ],
      });
      await client.request("turn/steer", {
        threadId: thread.id,
        expectedTurnId: turn.id,
        clientUserMessageId: crypto.randomUUID(),
        input: [{ type: "text", text: "Keep it concise.", text_elements: [] }],
      });
      await assert.rejects(
        client.request("turn/steer", {
          threadId: thread.id,
          expectedTurnId: "wrong-turn",
          input: [{ type: "text", text: "stale", text_elements: [] }],
        }),
      );
      await client.request("turn/interrupt", {
        threadId: thread.id,
        turnId: turn.id,
      });
      assert.equal((await second).status, "interrupted");
      assert.equal(child.exitCode, null);
      client.close();
      client = await connect();
      const current = await client.request("thread/read", {
        threadId: thread.id,
        includeTurns: true,
      });
      assert.equal(current.thread.turns.at(-1).status, "interrupted");
      toolMode = true;
      const toolThread = (
        await client.request("thread/start", {
          cwd: home,
          model: "gpt-5.4",
          approvalPolicy: "never",
          dynamicTools: [pushSyncTool],
        })
      ).thread;
      let called;
      client.toolHandler = async (params) => {
        called = params;
        return {
          success: true,
          contentItems: [
            { type: "inputText", text: "Approved, simulation only." },
          ],
        };
      };
      const toolDone = completed();
      await client.request("turn/start", {
        threadId: toolThread.id,
        input: [
          { type: "text", text: "Request push_sync.", text_elements: [] },
        ],
      });
      assert.equal((await toolDone).status, "completed");
      assert.equal(called.tool, "push_sync");
      assert.ok(
        JSON.stringify(toolInput.input).includes("Approved, simulation only."),
      );
      client.close();
      client = await connect();
      const restored = await client.request("thread/resume", {
        threadId: toolThread.id,
      });
      assert.ok(
        restored.thread.turns[0].items.some(
          (item) => item.type === "dynamicToolCall" && item.success,
        ),
      );
    } catch (error) {
      console.error(logs.slice(-4000));
      throw error;
    } finally {
      client?.close();
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
      model.closeAllConnections();
      await new Promise((resolve) => model.close(resolve));
      await rm(home, { recursive: true, force: true });
    }
  },
);
