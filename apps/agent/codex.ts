import type { getSandbox } from "@cloudflare/sandbox";
import { AppServer } from "./app-server.ts";

export type CodexSandbox = ReturnType<typeof getSandbox>;
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
  run?: Run;
  threadId?: string;
};
export async function connectCodex(sandbox: CodexSandbox, state: CodexState) {
  const warm = (await sandbox.exists(readyFile)).exists;
  let threadId = state.threadId;
  if (!warm) {
    {
      const initialized = await sandbox.exec(
        "mkdir -p /workspace/repo /workspace/codex && git init /workspace/repo",
      );
      if (!initialized.success)
        throw new Error("Could not initialize workspace.");
    }
    threadId = undefined;
    const configured = await sandbox.exec(
      "cp /opt/codex-config.toml /workspace/codex/config.toml",
    );
    if (!configured.success) throw new Error("Could not configure Codex.");
    await sandbox.writeFile(tokenFile, crypto.randomUUID());
    await sandbox.writeFile(readyFile, "ready");
  }
  const process = await sandbox.getProcess(SERVER_ID);
  if (!process || !["running", "starting"].includes(process.status)) {
    if (process) await sandbox.cleanupCompletedProcesses();
    const server = await sandbox.startProcess(
      `codex app-server --listen ws://0.0.0.0:${SERVER_PORT} --ws-auth capability-token --ws-token-file ${tokenFile}`,
      {
        processId: SERVER_ID,
        autoCleanup: false,
        env: { CODEX_HOME: "/workspace/codex" },
      },
    );
    await server.waitForPort(SERVER_PORT, { path: "/readyz" });
  } else if (process.status === "starting") {
    await process.waitForPort(SERVER_PORT, { path: "/readyz" });
  }
  const { content: token } = await sandbox.readFile(tokenFile);
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
    await client.initialize();
  } catch (error) {
    client.close();
    throw error;
  }
  return { client, threadId };
}
