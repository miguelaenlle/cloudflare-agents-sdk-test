import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { UIMessageChunk } from "ai";
import { CodexEvents } from "../codex-events.ts";
import {
  checkpointCodex,
  forceStopCodex,
  observeCodex,
  prepareSandbox,
  stopCodex,
  type CodexSandbox,
  type Run,
} from "../codex.ts";

const fixture = [
  { type: "thread.started", thread_id: "native-thread" },
  {
    type: "item.completed",
    item: { id: "reason", type: "reasoning", text: "private" },
  },
  {
    type: "item.started",
    item: { id: "cmd", type: "command_execution", command: "cat hello.txt" },
  },
  {
    type: "item.completed",
    item: {
      id: "cmd",
      type: "command_execution",
      command: "cat hello.txt",
      aggregated_output: "hello",
      exit_code: 0,
    },
  },
  {
    type: "item.completed",
    item: {
      id: "edit",
      type: "file_change",
      changes: [{ path: "hello.txt", kind: "add" }],
    },
  },
  {
    type: "item.completed",
    item: { id: "answer", type: "agent_message", text: "Hello 🌍" },
  },
  {
    type: "turn.completed",
    usage: {
      input_tokens: 1,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 1,
    },
  },
];
const jsonl = fixture.map((event) => JSON.stringify(event)).join("\n") + "\n";

function logStream(stdout = jsonl, exit = true) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of [
        { type: "stdout", data: stdout },
        ...(exit ? [{ type: "exit", data: "" }] : []),
      ]) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      }
      controller.close();
    },
  });
}

test("JSONL survives arbitrary chunk boundaries and emits each UI item once", () => {
  const chunks: UIMessageChunk[] = [];
  const events = new CodexEvents((chunk) => chunks.push(chunk));
  for (const char of jsonl) events.push(char);
  events.push(JSON.stringify(fixture[3]) + "\n");
  assert.equal(
    chunks.filter((chunk) => chunk.type === "tool-input-available").length,
    2,
  );
  assert.equal(
    chunks.filter((chunk) => chunk.type === "tool-output-available").length,
    2,
  );
  assert.equal(chunks.filter((chunk) => chunk.type === "text-delta").length, 1);
  assert.ok(!JSON.stringify(chunks).includes("private"));
});

test("the UI mapper ignores lifecycle events but rejects malformed JSON", () => {
  const chunks: UIMessageChunk[] = [];
  const events = new CodexEvents((chunk) => chunks.push(chunk));
  events.push('{"type":"turn.failed","error":{"message":"quota exceeded"}}\n');
  assert.deepEqual(chunks, []);
  assert.throws(() => events.push("invalid JSON\n"));
});

test("an observer can replay a finished run without launching any process", async () => {
  const run: Run = {
    id: crypto.randomUUID(),
    messageId: "user-1",
    startedAt: Date.now(),
    status: "running",
  };
  const sandbox = {
    getProcess: async () => ({ status: "completed" }),
    streamProcessLogs: async () => logStream(),
    exists: async () => ({ exists: true }),
    readFile: async (path: string) => ({
      content: path.endsWith("result.json")
        ? JSON.stringify({ status: "completed" })
        : jsonl,
    }),
  } as unknown as CodexSandbox;
  const first: UIMessageChunk[] = [];
  const second: UIMessageChunk[] = [];
  await observeCodex(sandbox, run, (chunk) => first.push(chunk));
  await observeCodex(sandbox, run, (chunk) => second.push(chunk));
  assert.deepEqual(first, second);
});

test("a lost container reports interruption instead of relaunching edits", async () => {
  const sandbox = {
    getProcess: async () => null,
    exists: async () => ({ exists: false }),
  } as unknown as CodexSandbox;
  const result = await observeCodex(
    sandbox,
    {
      id: crypto.randomUUID(),
      messageId: "user-1",
      startedAt: Date.now(),
      status: "running",
    },
    () => {},
  );
  assert.match(result.error!, /interrupted/);
});

test("cold restore uses the thread paired with the checkpoint; backup errors propagate", async () => {
  const backup = { id: "saved", dir: "/workspace" };
  const calls: string[] = [];
  const sandbox = {
    exists: async () => ({ exists: false }),
    restoreBackup: async (handle: unknown) => {
      assert.deepEqual(handle, backup);
      calls.push("restore");
    },
    writeFile: async () => {
      calls.push("ready");
    },
    createBackup: async () => {
      throw new Error("R2 unavailable");
    },
  } as unknown as CodexSandbox;
  const threadId = await prepareSandbox(sandbox, {
    threadId: "uncheckpointed",
    checkpoint: { backup, threadId: "saved-thread" },
  });
  assert.equal(threadId, "saved-thread");
  assert.deepEqual(calls, ["restore", "ready"]);
  await assert.rejects(checkpointCodex(sandbox), /R2 unavailable/);
});

async function makeRunner(
  t: { after: (fn: () => Promise<void>) => void },
  prompt: string,
  maxDurationMs = 5000,
) {
  const dir = await mkdtemp(join(tmpdir(), "codex-runner-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const run = join(dir, "run");
  await mkdir(bin);
  await mkdir(run);
  await writeFile(
    join(bin, "codex"),
    `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
appendFileSync(process.env.CODEX_WORKSPACE + '/launches', '1');
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
writeFileSync(process.env.CODEX_WORKSPACE + '/received.json', JSON.stringify({ prompt, args: process.argv.slice(2) }));
if (prompt === 'wait') {
  writeFileSync(process.env.CODEX_WORKSPACE + '/child.pid', String(process.pid));
  setInterval(() => {}, 1000);
} else if (prompt === 'failed') {
  process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'quota exceeded' } }) + '\\n');
} else if (prompt === 'incomplete') {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'native-thread' }) + '\\n');
} else if (prompt === 'secret-output') {
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'secret', type: 'agent_message', text: 'key: ' + process.env.CODEX_API_KEY } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'failure: ' + process.env.CODEX_API_KEY } }) + '\\n');
} else if (prompt === 'secret-crash') {
  process.stderr.write('failure: ' + process.env.CODEX_API_KEY);
  process.exitCode = 1;
} else if (prompt === 'crash') {
  process.stderr.write('fixture crashed');
  process.exitCode = 1;
} else {
  process.stdout.write(${JSON.stringify(jsonl)});
}
`,
    { mode: 0o755 },
  );
  await writeFile(join(bin, "package.json"), '{"type":"module"}');
  await writeFile(
    join(run, "input.json"),
    JSON.stringify({ prompt, threadId: "saved-thread", maxDurationMs }),
  );
  const launch = () => {
    const child = spawn(
      process.execPath,
      [new URL("../run-codex.mjs", import.meta.url).pathname, run],
      {
        env: {
          ...process.env,
          CODEX_PATH: join(bin, "codex"),
          CODEX_API_KEY: "test-secret-canary",
          CODEX_WORKSPACE: dir,
        },
        stdio: "pipe",
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (data) => {
      stdout += data;
    });
    child.stderr.setEncoding("utf8").on("data", (data) => {
      stderr += data;
    });
    return Object.assign(child, { output: () => ({ stdout, stderr }) });
  };
  return { dir, run, launch };
}

test("SDK runner passes prompts safely, resumes explicitly, and claims a run once", async (t) => {
  const prompt = "hello; $(touch SHOULD_NOT_EXIST) `whoami`\nsecond line";
  const { dir, run, launch } = await makeRunner(t, prompt);
  const child = launch();
  assert.equal((await once(child, "close"))[0], 0);
  assert.equal((await once(launch(), "close"))[0], 0);
  assert.equal(await readFile(join(dir, "launches"), "utf8"), "1");
  const received = JSON.parse(
    await readFile(join(dir, "received.json"), "utf8"),
  );
  assert.equal(received.prompt, prompt);
  assert.equal(received.args[0], "exec");
  assert.equal(
    received.args[received.args.indexOf("resume") + 1],
    "saved-thread",
  );
  assert.equal(child.output().stdout, jsonl);
  assert.ok(received.args.includes('cli_auth_credentials_store="ephemeral"'));
  assert.ok(received.args.includes('shell_environment_policy.inherit="none"'));
  assert.ok(!JSON.stringify(received.args).includes("test-secret-canary"));
  await assert.rejects(readFile(join(run, "events.jsonl")), { code: "ENOENT" });
});

test("SDK run deadline aborts the Codex subprocess", async (t) => {
  const { dir, run, launch } = await makeRunner(t, "wait", 1000);
  assert.equal((await once(launch(), "exit"))[0], 0);
  const result = JSON.parse(await readFile(join(run, "result.json"), "utf8"));
  assert.equal(result.status, "timed-out");
  assert.match(result.error, /ten-minute/);
  const pid = Number(await readFile(join(dir, "child.pid"), "utf8"));
  await delay(100);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("item IDs remain stable on replay but differ across runs", () => {
  const first: UIMessageChunk[] = [];
  const second: UIMessageChunk[] = [];
  new CodexEvents((chunk) => first.push(chunk), "run-a").push(jsonl);
  new CodexEvents((chunk) => second.push(chunk), "run-b").push(jsonl);
  const a = first.find((chunk) => chunk.type === "tool-input-available")!;
  const b = second.find((chunk) => chunk.type === "tool-input-available")!;
  assert.notEqual(a.toolCallId, b.toolCallId);
});

test("cancellation discards an incomplete last JSON line and settles pending tools", () => {
  const chunks: UIMessageChunk[] = [];
  const events = new CodexEvents((chunk) => chunks.push(chunk));
  events.push(JSON.stringify(fixture[2]) + '\n{"type":');
  events.failTools("Cancelled");
  assert.equal(chunks.at(-1)?.type, "tool-output-error");
});

test("Stop requests SDK cancellation; only deadline cleanup forces termination", async () => {
  const run: Run = {
    id: crypto.randomUUID(),
    messageId: "user-1",
    startedAt: Date.now(),
    status: "running",
  };
  let status = "running";
  let kills = 0;
  let markers = 0;
  const sandbox = {
    getProcess: async () => ({ status }),
    writeFile: async (path: string) => {
      assert.ok(path.endsWith("/cancel"));
      markers++;
    },
    streamProcessLogs: async () => logStream("", false),
    killProcess: async () => {
      kills++;
      status = "killed";
    },
  } as unknown as CodexSandbox;
  await assert.rejects(stopCodex(sandbox, run), /has not stopped/);
  assert.equal(kills, 0);
  assert.equal(markers, 1);
  await forceStopCodex(sandbox, run);
  await stopCodex(sandbox, run);
  assert.equal(kills, 1);
});

test("a cancellation marker aborts the SDK subprocess and records a resumable cancelled turn", async (t) => {
  const { dir, run, launch } = await makeRunner(t, "wait");
  const child = launch();
  const closed = once(child, "close");
  // Wait for the fake native process to announce readiness, not an arbitrary delay.
  for (let tries = 0; ; tries++) {
    try {
      await readFile(join(dir, "child.pid"));
      break;
    } catch (error) {
      if (tries === 100) throw error;
      await delay(20);
    }
  }
  await writeFile(join(run, "cancel"), "cancel");
  assert.equal((await closed)[0], 0);
  const result = JSON.parse(await readFile(join(run, "result.json"), "utf8"));
  assert.deepEqual(result, { status: "cancelled" });
  const pid = Number(await readFile(join(dir, "child.pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("a cancellation that arrives before runner startup is not lost", async (t) => {
  const { run, launch } = await makeRunner(t, "wait");
  await writeFile(join(run, "cancel"), "cancel");
  assert.equal((await once(launch(), "close"))[0], 0);
  assert.deepEqual(
    JSON.parse(await readFile(join(run, "result.json"), "utf8")),
    { status: "cancelled" },
  );
});

test("the runner records completed, failed, and incomplete native turns", async (t) => {
  for (const [prompt, status, error] of [
    ["ok", "completed", undefined],
    ["failed", "failed", /quota exceeded/],
    ["incomplete", "failed", /without completing/],
    ["crash", "failed", /fixture crashed/],
  ] as const) {
    await t.test(prompt, async (t) => {
      const { run, launch } = await makeRunner(t, prompt);
      assert.equal((await once(launch(), "exit"))[0], 0);
      const result = JSON.parse(
        await readFile(join(run, "result.json"), "utf8"),
      );
      assert.equal(result.status, status);
      if (error) assert.match(result.error, error);
      else assert.equal(result.error, undefined);
    });
  }
});

test("a killed runner without a result leaves partial output interrupted", async () => {
  const chunks: UIMessageChunk[] = [];
  const sandbox = {
    getProcess: async () => ({ status: "killed" }),
    streamProcessLogs: async () =>
      logStream(JSON.stringify(fixture[2]) + '\n{"type":'),
    exists: async () => ({ exists: false }),
    readFile: async () => ({
      content: JSON.stringify(fixture[2]) + '\n{"type":',
    }),
  } as unknown as CodexSandbox;
  const result = await observeCodex(
    sandbox,
    {
      id: crypto.randomUUID(),
      messageId: "user-1",
      startedAt: Date.now(),
      status: "running",
    },
    (chunk) => chunks.push(chunk),
  );
  assert.equal(result.status, "interrupted");
  assert.equal(chunks.at(-1)?.type, "tool-output-error");
});

test("a result file cannot finish observation before the process exits", async () => {
  let checks = 0;
  const sandbox = {
    getProcess: async () => ({
      status: ++checks === 1 ? "running" : "completed",
    }),
    streamProcessLogs: async () => logStream(),
    exists: async () => ({ exists: true }),
    readFile: async (path: string) => ({
      content: path.endsWith("result.json") ? '{"status":"completed"}' : jsonl,
    }),
  } as unknown as CodexSandbox;
  const result = await observeCodex(
    sandbox,
    {
      id: crypto.randomUUID(),
      messageId: "user-1",
      startedAt: Date.now(),
      status: "running",
    },
    () => {},
  );
  assert.equal(checks, 2);
  assert.equal(result.status, "completed");
});

test("a disconnected output stream cannot masquerade as completion", async () => {
  const sandbox = {
    getProcess: async () => ({ status: "running" }),
    streamProcessLogs: async () => logStream(jsonl, false),
  } as unknown as CodexSandbox;
  await assert.rejects(
    observeCodex(
      sandbox,
      {
        id: crypto.randomUUID(),
        messageId: "user-1",
        startedAt: Date.now(),
        status: "running",
      },
      () => {},
    ),
    /disconnected before exit/,
  );
});

test("checkpoints exclude old auth and logs while run artifacts live outside the workspace", async () => {
  let options;
  await checkpointCodex({
    createBackup: async (value: unknown) => {
      options = value;
    },
  } as unknown as CodexSandbox);
  assert.deepEqual(options, {
    dir: "/workspace",
    ttl: 2592000,
    excludes: ["codex/auth.json", "codex/log", "runs"],
  });
});

test("known injected credentials are redacted before stdout and result persistence", async (t) => {
  for (const prompt of ["secret-output", "secret-crash"]) {
    const { run, launch } = await makeRunner(t, prompt);
    const child = launch();
    assert.equal((await once(child, "close"))[0], 0);
    const result = await readFile(join(run, "result.json"), "utf8");
    const { stdout, stderr } = child.output();
    assert.ok(!(stdout + stderr + result).includes("test-secret-canary"));
    assert.ok(result.includes("[REDACTED]"));
    if (prompt === "secret-output") assert.ok(stdout.includes("[REDACTED]"));
  }
});
