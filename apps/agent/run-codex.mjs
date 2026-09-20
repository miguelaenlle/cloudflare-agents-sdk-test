import { Codex } from "@openai/codex-sdk";
import {
  existsSync,
  watch,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";

const runDir = process.argv[2];
// A repeated launch must never execute the same prompt twice.
try {
  mkdirSync(join(runDir, "claimed"));
} catch (error) {
  if (error.code === "EEXIST") process.exit(0);
  throw error;
}
const { prompt, threadId, model, expiresAt } = JSON.parse(
  readFileSync(join(runDir, "input.json"), "utf8"),
);
const controller = new AbortController();
const checkCancellation = () => {
  if (existsSync(join(runDir, "cancel"))) controller.abort();
};
// Register before checking so cancellation during startup cannot be missed.
const cancellation = watch(runDir, checkCancellation);
checkCancellation();
const apiKey = process.env.CODEX_API_KEY;
const serialize = (value) =>
  JSON.stringify(value, (_key, item) =>
    typeof item === "string" && apiKey
      ? item.split(apiKey).join("[REDACTED]")
      : item,
  );
let timedOut = false;
const timeout = setTimeout(
  () => {
    timedOut = true;
    controller.abort();
  },
  Math.max(0, expiresAt - Date.now()),
);
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());

let completed = false;
let error;
try {
  const codex = new Codex({
    apiKey,
    // The native process needs the key; its shell tools do not.
    env: Object.fromEntries(
      ["PATH", "HOME", "LANG", "CODEX_HOME", "CODEX_WORKSPACE"]
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]]),
    ),
    config: {
      cli_auth_credentials_store: "ephemeral",
      log_dir: "/tmp/codex-logs",
      shell_environment_policy: {
        inherit: "none",
        set: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: process.env.HOME || "/root",
        },
      },
    },
    codexPathOverride: process.env.CODEX_PATH,
  });
  const options = {
    workingDirectory: process.env.CODEX_WORKSPACE || "/workspace/repo",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    model,
  };
  const thread = threadId
    ? codex.resumeThread(threadId, options)
    : codex.startThread(options);
  const { events } = await thread.runStreamed(prompt, {
    signal: controller.signal,
  });
  for await (const event of events) {
    process.stdout.write(serialize(event) + "\n");
    if (event.type === "turn.completed") {
      completed = true;
      error = undefined;
    }
    if (event.type === "turn.failed") error = event.error.message;
    if (event.type === "error") error = event.message;
    if (event.type === "thread.started")
      writeFileSync(join(runDir, "thread-id"), event.thread_id);
  }
} catch (cause) {
  if (!controller.signal.aborted)
    error = cause instanceof Error ? cause.message : "Codex failed.";
} finally {
  clearTimeout(timeout);
  cancellation.close();
  let status;
  if (timedOut) {
    status = "timed-out";
    error = "Sandbox reached its six-hour lifetime limit.";
  } else if (controller.signal.aborted) {
    status = "cancelled";
    error = undefined;
  } else if (completed && !error) {
    status = "completed";
  } else {
    status = "failed";
    error ??= "Codex exited without completing.";
  }
  writeFileSync(join(runDir, "result.tmp"), serialize({ status, error }));
  renameSync(join(runDir, "result.tmp"), join(runDir, "result.json"));
}
