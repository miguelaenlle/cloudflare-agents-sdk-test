import type { DirectoryBackup, getSandbox } from "@cloudflare/sandbox";
import type { Approval } from "@playground/chat-contract";
import { AppServer } from "./app-server.ts";

export type CodexSandbox = ReturnType<typeof getSandbox>;
export const SANDBOX_IDLE_MS = 10 * 60_000;
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
  };
  run?: Run;
  threadId?: string;
  checkpoint?: { backup: DirectoryBackup; threadId?: string };
};
export class ContainerLost extends Error {
  constructor() {
    super(
      "Sandbox was lost. Send another message to restore the last checkpoint.",
    );
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
  const warm = (await sandbox.exists(readyFile)).exists;
  assertCurrent();
  if (!warm && recovery) throw new ContainerLost();
  let threadId = state.threadId;
  if (!warm) {
    if (state.checkpoint) await sandbox.restoreBackup(state.checkpoint.backup);
    else {
      if (repository && !/^[\w.-]+\/[\w.-]+$/.test(repository))
        throw new Error("Invalid configured GitHub repository.");
      // The outbound handler injects credentials and uses HTTPS upstream; local sandbox TLS interception is unavailable.
      const initialized = await sandbox.exec(
        repository
          ? `mkdir -p /workspace/codex && git clone http://github.com/${repository}.git /workspace/repo`
          : "mkdir -p /workspace/repo /workspace/codex && git init /workspace/repo",
      );
      if (!initialized.success)
        throw new Error("Could not initialize workspace.");
    }
    assertCurrent();
    threadId = state.checkpoint?.threadId;
    const configured = await sandbox.exec(
      "cp /opt/codex-config.toml /workspace/codex/config.toml",
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
    const server = await sandbox.startProcess(
      `codex app-server --listen ws://0.0.0.0:${SERVER_PORT} --ws-auth capability-token --ws-token-file ${tokenFile}`,
      {
        processId: SERVER_ID,
        autoCleanup: false,
        env: { CODEX_HOME: "/workspace/codex" },
      },
    );
    assertCurrent();
    await server.waitForPort(SERVER_PORT, { path: "/readyz" });
  } else if (process.status === "starting") {
    await process.waitForPort(SERVER_PORT, { path: "/readyz" });
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
    await client.initialize();
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
