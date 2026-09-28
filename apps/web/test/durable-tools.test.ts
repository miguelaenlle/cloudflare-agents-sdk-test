import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

// Real relay, Postgres, and local Worker; the native Codex/sandbox is a protocol fixture.
test(
  "explicit durable tool preparation, reconnect, warm denial and cold approval",
  { timeout: 90000 },
  async () => {
    const schema = `test_${crypto.randomUUID().replaceAll("-", "")}`;
    const database = new URL(
      process.env.DATABASE_URL ?? "postgresql://localhost/course_agent",
    );
    const admin = new pg.Client({ connectionString: database.toString() });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    database.searchParams.set("options", `-c search_path=${schema}`);
    const state = await mkdtemp(join(tmpdir(), "durable-tool-worker-"));
    let logs = "";
    const children: ChildProcess[] = [];
    const streams: AbortController[] = [];
    function child(command: string, args: string[], env = process.env) {
      const proc = spawn(command, args, { stdio: "pipe", detached: true, env });
      children.push(proc);
      proc.stdout!.on("data", (chunk) => {
        logs += chunk;
      });
      proc.stderr!.on("data", (chunk) => {
        logs += chunk;
      });
      return proc;
    }
    async function stop(proc: ChildProcess) {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      const exited = once(proc, "exit");
      process.kill(-proc.pid!, "SIGTERM");
      await exited;
    }
    const worker = "http://127.0.0.1:8794";
    const relay = "http://127.0.0.1:4320";
    async function get(url: string) {
      return (await fetch(url)).json();
    }
    async function post(url: string, body: unknown = {}) {
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    async function eventually(predicate: () => Promise<boolean>) {
      for (let i = 0; i < 150; i++) {
        if (await predicate().catch(() => false)) return;
        await delay(100);
      }
      assert.fail(logs);
    }
    function startRelay() {
      return child(
        process.execPath,
        ["--experimental-strip-types", "server/server.ts"],
        {
          ...process.env,
          AGENT_URL: worker,
          PORT: "4320",
          PUSH_MODE: "simulated",
          DATABASE_URL: database.toString(),
          GITHUB_TOKEN: "unused-fixture",
          RELAY_TOKEN: "",
        },
      );
    }
    async function watch(api: string) {
      const controller = new AbortController();
      streams.push(controller);
      const response = await fetch(`${api}/events`, {
        signal: controller.signal,
      });
      assert.equal(response.status, 200);
      void (async () => {
        try {
          for await (const _ of response.body!) {
          }
        } catch {}
      })();
      return controller;
    }
    try {
      child("../agent/node_modules/.bin/wrangler", [
        "dev",
        "--config",
        "../agent/test/wrangler.jsonc",
        "--port",
        "8794",
        "--inspector-port",
        "0",
        "--persist-to",
        state,
      ]);
      let server = startRelay();
      await eventually(
        async () =>
          (await fetch(`${worker}/agents/chat/playground/snapshot`)).ok &&
          (await fetch(`${relay}/api/conversations`)).ok,
      );
      for (const cold of [false, true]) {
        const conversation = await (
          await post(`${relay}/api/conversations`, {
            title: cold ? "Cold approval" : "Warm denial",
          })
        ).json();
        const api = `${relay}/api/conversations/${conversation.id}/chat`;
        const native = `${worker}/agents/chat/${conversation.id}`;
        assert.equal(
          (
            await post(api, {
              id: crypto.randomUUID(),
              expectedRevision: 0,
              text: "Prepare changes",
            })
          ).status,
          204,
        );
        assert.equal((await post(`${native}/test/approval`)).status, 204);
        await eventually(
          async () => !!(await get(`${native}/snapshot`)).pendingTool,
        );
        // Reading snapshots cannot create proposals, even with a captured pending call.
        for (let i = 0; i < 2; i++)
          assert.equal((await get(`${api}/snapshot`)).approval, undefined);
        const first = await watch(api);
        await watch(api);
        await eventually(
          async () => !!(await get(`${native}/snapshot`)).pendingTool?.prepared,
        );
        let snapshot = await get(`${api}/snapshot`);
        assert.equal(snapshot.approval.status, "pending");
        const id = snapshot.approval.id;
        assert.equal(
          (
            await post(api, {
              id: crypto.randomUUID(),
              expectedRevision: snapshot.revision,
              text: "Do not bypass pending call",
            })
          ).status,
          409,
        );
        first.abort();
        if (cold) {
          await stop(server);
          server = startRelay();
          await eventually(
            async () => (await fetch(`${relay}/api/conversations`)).ok,
          );
          await watch(api);
          await eventually(
            async () => (await get(`${api}/snapshot`)).approval?.id === id,
          );
          assert.equal(
            (await post(`${native}/test/advance`, { milliseconds: 601000 })).ok,
            true,
          );
          const suspended = await get(`${native}/test/state`);
          assert.equal(suspended.sandbox, undefined, logs);
          assert.ok(suspended.checkpoint);
          assert.equal((await get(`${api}/snapshot`)).approval.id, id);
        }
        snapshot = await get(`${api}/snapshot`);
        const decision = {
          id,
          digest: snapshot.approval.digest,
          approved: cold,
          expectedRevision: snapshot.revision,
        };
        if (cold) {
          await post(`${native}/test/launch`, { failLaunch: true });
          const failed = await post(`${api}/approval`, decision);
          assert.equal(failed.status, 502);
          assert.equal(
            (await get(`${api}/snapshot`)).approval.status,
            "approved",
          );
          assert.ok((await get(`${native}/snapshot`)).pendingTool);
        }
        const responses = await Promise.all([
          post(`${api}/approval`, decision),
          post(`${api}/approval`, decision),
        ]);
        assert.ok(
          responses.some((r) => r.status === 204),
          await Promise.all(responses.map((r) => r.text())),
        );
        assert.equal((await post(`${api}/approval`, decision)).status, 204);
        const after = await get(`${api}/snapshot`);
        assert.equal(after.approval.status, cold ? "approved" : "denied");
        assert.equal(after.pendingTool, undefined);
        assert.equal(after.blocked, false);
        const nativeStatus = await get(`${native}/test/status`);
        if (!cold) assert.equal(nativeStatus.toolResults.length, 1);
        else {
          assert.ok((await get(`${native}/test/state`)).sandbox);
          assert.equal(
            after.messages.filter((m: { id: string }) => m.id === id).length,
            1,
          );
        }
        const records = await admin.query(
          `SELECT count(*)::int AS count FROM ${schema}.publications WHERE conversation_id=$1`,
          [conversation.id],
        );
        assert.equal(records.rows[0].count, 1);
      }
    } finally {
      for (const stream of streams) stream.abort();
      for (const proc of children.reverse()) await stop(proc);
      await rm(state, { recursive: true, force: true });
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
