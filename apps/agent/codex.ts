import type { DirectoryBackup, getSandbox } from "@cloudflare/sandbox";
import type { Approval, CleanupDiagnostics } from "@playground/chat-contract";
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
  submitted?: boolean;
  status: "running" | "completed" | "cancelled" | "failed" | "interrupted";
};
export type CodexState = {
  revision?: number;
  approval?: Approval;
  approvalHistory?: Approval[];
  approvalDelivery?: string;
  approvalPreparing?: boolean;
  approvalReceipts?: Record<string, { digest: string; approved: boolean }>;
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
    const message = error instanceof Error ? error.message : "";
    let detail = "Check the Worker and container logs for this stage.";
    if (
      /maximum number of running container instances exceeded/i.test(message)
    ) {
      detail =
        "Cloudflare's running-container limit is reached. Wait for an idle sandbox to shut down, or increase containers[].max_instances in wrangler.jsonc and redeploy.";
    } else if (/no container instance.*(provided|available)/i.test(message)) {
      detail =
        "Cloudflare could not allocate a container. Check container provisioning and available capacity, then retry.";
    } else if (/timeout|timed out/i.test(message)) {
      detail =
        "The operation timed out. Check container startup and connectivity, then retry.";
    }
    throw new Error(`Sandbox startup failed while ${stage}. ${detail}`);
  }
}

export async function connectCodex(
  sandbox: CodexSandbox,
  state: CodexState,
  {
    repository,
    recovery = false,
    assertCurrent = () => {},
  }: {
    repository?: string;
    recovery?: boolean;
    assertCurrent?: () => void;
  } = {},
) {
  // Expiration can interleave with SDK awaits; stop before issuing another operation.
  assertCurrent();
  const warm = (
    await startupStep("allocating the container", () =>
      sandbox.exists(readyFile),
    )
  ).exists;
  assertCurrent();
  if (!warm && recovery) throw new ContainerLost();
  let threadId = state.threadId;
  if (!warm) {
    if (state.checkpoint) {
      const { backup } = state.checkpoint;
      await startupStep("restoring the workspace backup", () =>
        sandbox.restoreBackup(backup),
      );
    } else {
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
    assertCurrent();
    threadId = state.checkpoint?.threadId;
    const configured = await startupStep("configuring Codex", () =>
      sandbox.exec("cp /opt/codex-config.toml /workspace/codex/config.toml", {
        timeout: 60_000,
      }),
    );
    assertCurrent();
    if (!configured.success) throw new Error("Could not configure Codex.");
    await sandbox.writeFile(tokenFile, crypto.randomUUID());
    assertCurrent();
    await sandbox.writeFile(readyFile, "ready");
  }
  assertCurrent();
  const process = await sandbox.getProcess(SERVER_ID);
  assertCurrent();
  if (!process || !["running", "starting"].includes(process.status)) {
    if (recovery) throw new ContainerLost();
    if (process) await sandbox.cleanupCompletedProcesses();
    assertCurrent();
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
    assertCurrent();
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
  assertCurrent();
  const { content: token } = await sandbox.readFile(tokenFile);
  assertCurrent();
  const response = await sandbox.wsConnect(
    new Request("http://sandbox/", {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        Authorization: `Bearer ${token}`,
      },
    }),
    SERVER_PORT,
  );
  if (!response.webSocket)
    throw new Error(
      `Could not connect to Codex app-server (HTTP ${response.status}).`,
    );
  response.webSocket.accept();
  const client = new AppServer(response.webSocket);
  try {
    assertCurrent();
    await startupStep("initializing the Codex connection", () =>
      client.initialize(),
    );
    assertCurrent();
  } catch (error) {
    client.close();
    throw error;
  }
  return { client, threadId };
}

export function checkpointCodex(sandbox: CodexSandbox, localBucket = false) {
  return sandbox.createBackup({
    dir: "/workspace",
    localBucket,
    ttl: 30 * 24 * 60 * 60,
    // SDK 0.12.9 expands slash-containing patterns in a way that excludes the parent.
    excludes: ["auth.json"],
  });
}
