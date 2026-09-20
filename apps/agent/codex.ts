import {
  parseSSEStream,
  type DirectoryBackup,
  type LogEvent,
  type getSandbox,
} from "@cloudflare/sandbox";
import type { UIMessageChunk } from "ai";
import { z } from "zod";
import { CodexEvents } from "./codex-events.ts";

export type CodexSandbox = ReturnType<typeof getSandbox>;
export const MAX_RUN_MS = 10 * 60_000;
export type Run = {
  id: string;
  messageId: string;
  startedAt: number;
  stopReason?: "cancelled" | "interrupted" | "deadline";
  status: "running" | "completed" | "cancelled" | "failed" | "interrupted";
};
export type CodexState = {
  threadId?: string;
  checkpoint?: { backup: DirectoryBackup; threadId?: string };
  run?: Run;
};

const resultSchema = z.object({
  status: z.enum(["completed", "failed", "cancelled", "timed-out"]),
  error: z.string().optional(),
});
const readyFile = "/tmp/codex-ready";
export function runDirectory(id: string) {
  return `/tmp/codex-runs/${z.uuid().parse(id)}`;
}

export async function prepareSandbox(sandbox: CodexSandbox, state: CodexState) {
  if ((await sandbox.exists(readyFile)).exists) return state.threadId;
  if (state.checkpoint) {
    await sandbox.restoreBackup(state.checkpoint.backup);
  } else {
    const result = await sandbox.exec(
      "mkdir -p /workspace/repo /workspace/codex && git init /workspace/repo",
    );
    if (!result.success)
      throw new Error("Could not initialize the Codex workspace.");
  }
  await sandbox.writeFile(readyFile, "ready");
  return state.checkpoint?.threadId;
}

export async function startCodex(
  sandbox: CodexSandbox,
  run: Run,
  input: { prompt: string; threadId?: string; model?: string; apiKey: string },
) {
  const dir = runDirectory(run.id);
  await sandbox.mkdir(dir, { recursive: true });
  // Only non-secret input goes on disk; the prompt never becomes shell syntax.
  await sandbox.writeFile(
    `${dir}/input.json`,
    JSON.stringify({
      prompt: input.prompt,
      threadId: input.threadId,
      model: input.model,
      maxDurationMs: MAX_RUN_MS,
    }),
  );
  await sandbox.startProcess(`node /opt/run-codex.mjs ${dir}`, {
    processId: run.id,
    autoCleanup: false,
    timeout: MAX_RUN_MS + 10_000,
    env: { CODEX_API_KEY: input.apiKey, CODEX_HOME: "/workspace/codex" },
  });
}

function isActive(process: { status: string } | null | undefined) {
  return process?.status === "running" || process?.status === "starting";
}

export async function observeCodex(
  sandbox: CodexSandbox,
  run: Run,
  write: (chunk: UIMessageChunk) => void,
  signal?: AbortSignal,
): Promise<{ status: Exclude<Run["status"], "running">; error?: string }> {
  const dir = runDirectory(run.id);
  const events = new CodexEvents(write, run.id);
  let toolError = "Codex stopped before reporting a result.";
  try {
    if (await sandbox.getProcess(run.id)) {
      // Cloudflare replays buffered stdout, then streams live output and exit.
      const stream = await sandbox.streamProcessLogs(run.id);
      let exited = false;
      for await (const event of parseSSEStream<LogEvent>(stream, signal)) {
        if (event.type === "stdout") events.push(event.data);
        if (event.type === "error")
          throw new Error("Codex output stream failed.");
        if (event.type === "exit") {
          exited = true;
          break;
        }
      }
      if (!exited)
        throw new Error("Codex output stream disconnected before exit.");
    }
    await confirmStopped(sandbox, run);
    if (!(await sandbox.exists(`${dir}/result.json`)).exists) {
      return {
        status: "interrupted",
        error:
          "Codex was interrupted. The task was not automatically repeated.",
      };
    }
    const { content } = await sandbox.readFile(`${dir}/result.json`);
    const result = resultSchema.parse(JSON.parse(content));
    toolError =
      result.status === "cancelled"
        ? "Cancelled"
        : (result.error ?? "Command did not report a result.");
    return {
      ...result,
      status: result.status === "timed-out" ? "failed" : result.status,
    };
  } finally {
    events.failTools(toolError);
  }
}

async function confirmStopped(sandbox: CodexSandbox, run: Run) {
  if (isActive(await sandbox.getProcess(run.id))) {
    throw new Error("Codex has not stopped; another turn cannot start yet.");
  }
}

export async function stopCodex(sandbox: CodexSandbox, run: Run) {
  if (!isActive(await sandbox.getProcess(run.id))) return;
  // The runner watches this marker and aborts the official SDK's signal.
  await sandbox.writeFile(`${runDirectory(run.id)}/cancel`, "cancel");
  const stream = await sandbox.streamProcessLogs(run.id);
  try {
    for await (const event of parseSSEStream<LogEvent>(
      stream,
      AbortSignal.timeout(5000),
    )) {
      if (event.type === "exit") break;
    }
  } catch {
    // Waiting is bounded, but Stop does not escalate to a forced kill.
    await confirmStopped(sandbox, run);
    return;
  }
  await confirmStopped(sandbox, run);
}

export async function forceStopCodex(sandbox: CodexSandbox, run: Run) {
  // Only the durable cleanup deadline uses Cloudflare's process termination.
  if (isActive(await sandbox.getProcess(run.id)))
    await sandbox.killProcess(run.id);
  await confirmStopped(sandbox, run);
}

export async function sandboxThread(
  sandbox: CodexSandbox,
  run: Run,
  fallback?: string,
) {
  const path = `${runDirectory(run.id)}/thread-id`;
  if (!(await sandbox.exists(path)).exists) return fallback;
  return (await sandbox.readFile(path)).content.trim();
}

export async function checkpointCodex(sandbox: CodexSandbox) {
  // Called only after the process has stopped, including on cancellation.
  return sandbox.createBackup({
    dir: "/workspace",
    ttl: 30 * 24 * 60 * 60,
    excludes: ["codex/auth.json", "codex/log", "runs"],
  });
}
