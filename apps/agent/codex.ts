import type { DirectoryBackup, getSandbox } from "@cloudflare/sandbox";
import type {
  PendingTool,
  CleanupDiagnostics,
} from "@playground/chat-contract";
import { safeFailure } from "./cleanup-error.ts";
import { AppServer } from "./app-server.ts";

export type CodexSandbox = ReturnType<typeof getSandbox>;
export const SANDBOX_IDLE_MS = 30_000;
export const USER_IDLE_MS = 6 * 60 * 60_000;
export const SERVER_ID = "codex-app-server";
export const SERVER_PORT = 4500;
const readyFile = "/tmp/codex-app-server-ready";
const tokenFile = "/tmp/codex-app-server-token";
export type Run = {
  id: string;
  messageId: string;
  sandboxId: string;
  threadId?: string;
  turnId?: string;
  /** Set before turn/start: a disconnect after this point requires native reconciliation. */
  submitted?: boolean;
  /** Native acknowledgment or correlated native history proves the prompt arrived. */
  accepted?: boolean;
  /** Stop during startup is applied before submitting native work. */
  cancelRequested?: boolean;
  status: "running" | "completed" | "cancelled" | "failed" | "interrupted";
};
/** Persisted in the Chat DO; filesystem contents live in the sandbox or its latest R2 checkpoint. */
export type CodexState = {
  pendingTool?: PendingTool;
  toolReceipts?: Record<string, string>;
  sandbox?: {
    id: string;
    phase:
      | "starting"
      | "waiting_for_agent"
      | "waiting_for_user"
      | "suspending"
      | "destroying"
      | "cleanup_failed";
    lastUserInteractionAt: number;
    waitingSince?: number;
    deadlineSchedule?: string;
    cleanup?: CleanupDiagnostics;
  };
  run?: Run;
  threadId?: string;
  checkpoint?: { backup: DirectoryBackup; threadId?: string };
  obsoleteCheckpoints?: string[];
  lastCheckpointError?: string;
};
export class ContainerLost extends Error {
  constructor() {
    super(
      "Sandbox was lost. Send another message to restore the last checkpoint.",
    );
  }
}

// Never send arbitrary SDK errors or process output to the browser: they can contain credentials.
async function startupStep<T>(
  stage: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(
      `Sandbox startup failed while ${stage}. ${safeFailure(error)}`,
    );
  }
}

/**
 * Reuse a warm app-server, or restore/configure a cold sandbox and authenticate its private socket.
 * Recovery mode only inspects surviving execution; it must never launch replacement work.
 */
export async function connectCodex(
  sandbox: CodexSandbox,
  state: CodexState,
  {
    repository,
    recovery = false,
    onCheckpointUnavailable = (_warning: string) => {},
  }: {
    repository?: string;
    recovery?: boolean;
    onCheckpointUnavailable?: (warning: string) => void;
  } = {},
) {
  const warm = (
    await startupStep("allocating the container", () =>
      sandbox.exists(readyFile),
    )
  ).exists;
  if (!warm && recovery) throw new ContainerLost();
  let threadId = state.threadId;
  let warning: string | undefined;
  if (!warm) {
    let restored = false;
    if (state.checkpoint) {
      const { backup } = state.checkpoint;
      await startupStep("restoring the workspace backup", async () => {
        try {
          await sandbox.restoreBackup(backup);
          restored = true;
        } catch (error) {
          // RPC preserves SDK error names, not subclass identity. Temporary outages must retain the checkpoint.
          if (
            !(error instanceof Error) ||
            !["BackupNotFoundError", "BackupExpiredError"].includes(error.name)
          )
            throw error;
          warning =
            "The checkpoint is missing or expired. Starting a fresh workspace from the configured repository; prior uncommitted files and Codex session context are unavailable.";
          onCheckpointUnavailable(warning);
        }
      });
    }
    if (!restored) {
      if (repository && !/^[\w.-]+\/[\w.-]+$/.test(repository))
        throw new Error("Invalid configured GitHub repository.");
      // The outbound handler injects credentials and uses HTTPS upstream; local sandbox TLS interception is unavailable.
      const initialized = await startupStep(
        "initializing the Git workspace",
        () =>
          sandbox.exec(
            repository
              ? `mkdir -p /workspace/codex && git clone http://github.com/${repository}.git /workspace/repo`
              : "mkdir -p /workspace/repo /workspace/codex && git init /workspace/repo",
            { timeout: 60_000 },
          ),
      );
      if (!initialized.success)
        throw new Error(
          `Could not initialize Git workspace (exit ${initialized.exitCode}). Check that the configured repository exists and GITHUB_TOKEN has access to it.`,
        );
    }
    threadId = restored ? state.checkpoint?.threadId : undefined;
    const configured = await startupStep("configuring Codex", () =>
      sandbox.exec("cp /opt/codex-config.toml /workspace/codex/config.toml", {
        timeout: 60_000,
      }),
    );
    if (!configured.success) throw new Error("Could not configure Codex.");
    await startupStep("writing the connection token", () =>
      sandbox.writeFile(tokenFile, crypto.randomUUID()),
    );
    await startupStep("marking workspace ready", () =>
      sandbox.writeFile(readyFile, "ready"),
    );
  }
  const process = await startupStep("reading process status", () =>
    sandbox.getProcess(SERVER_ID),
  );
  if (!process || !["running", "starting"].includes(process.status)) {
    if (recovery) throw new ContainerLost();
    if (process)
      await startupStep("cleaning old processes", () =>
        sandbox.cleanupCompletedProcesses(),
      );
    const server = await startupStep("launching Codex app-server", () =>
      sandbox.startProcess(
        `codex app-server --listen ws://0.0.0.0:${SERVER_PORT} --ws-auth capability-token --ws-token-file ${tokenFile}`,
        {
          processId: SERVER_ID,
          autoCleanup: false,
          env: { CODEX_HOME: "/workspace/codex" },
        },
      ),
    );
    await startupStep(
      "waiting for Codex app-server readiness (60-second limit)",
      () =>
        server.waitForPort(SERVER_PORT, { path: "/readyz", timeout: 60_000 }),
    );
  } else if (process.status === "starting") {
    await startupStep(
      "waiting for Codex app-server readiness (60-second limit)",
      () =>
        process.waitForPort(SERVER_PORT, { path: "/readyz", timeout: 60_000 }),
    );
  }
  const { content: token } = await startupStep(
    "reading the connection token",
    () => sandbox.readFile(tokenFile),
  );
  const response = await startupStep("connecting to Codex", () =>
    sandbox.wsConnect(
      new Request("http://sandbox/", {
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          Authorization: `Bearer ${token}`,
        },
      }),
      SERVER_PORT,
    ),
  );
  if (!response.webSocket)
    throw new Error(
      `Could not connect to Codex app-server (HTTP ${response.status}).`,
    );
  response.webSocket.accept();
  const client = new AppServer(response.webSocket);
  try {
    await startupStep("initializing the Codex connection", () =>
      client.initialize(),
    );
  } catch (error) {
    client.close();
    throw error;
  }
  return { client, threadId, warning };
}

/** Archive the workspace through the Sandbox SDK; credentials are injected outside these files. */
export function checkpointCodex(sandbox: CodexSandbox, localBucket = false) {
  return sandbox.createBackup({
    dir: "/workspace",
    localBucket,
    ttl: 7 * 24 * 60 * 60,
    // SDK 0.12.9 expands slash-containing patterns in a way that excludes the parent.
    excludes: ["auth.json"],
  });
}
