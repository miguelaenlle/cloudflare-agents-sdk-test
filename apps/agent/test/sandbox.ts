import { DurableObject } from "cloudflare:workers";
import type { ThreadItem, Turn } from "../protocol.ts";

type State = {
  files: Record<string, string>;
  waitingTool?: boolean;
  toolResults?: unknown[];
  backup?: Record<string, string>;
  backupEvents: string[];
  running: boolean;
  launches: number;
  restores: number;
  destroys: number;
  turns: Turn[];
  steers: number;
  failBackup?: boolean;
  destroyFailures?: number;
  ignoreCancellation?: boolean;
  dropStartAck?: boolean;
  steerBehavior?: "finish" | "lose-ack" | "reject";
};
const textItem = (id: string, text: string): ThreadItem => ({
  type: "agentMessage",
  id,
  text,
  phase: null,
  memoryCitation: null,
  delivery: null,
  questions: null,
});
const command = (status: "inProgress" | "completed"): ThreadItem => ({
  type: "commandExecution",
  id: "cmd",
  command: "sleep 8",
  cwd: "/workspace/repo",
  pluginId: null,
  scriptPath: null,
  processId: null,
  source: "agent",
  status,
  commandActions: [],
  aggregatedOutput: status === "completed" ? "done" : null,
  exitCode: status === "completed" ? 0 : null,
  durationMs: null,
});

// Persisted fake execution survives replacement of the relay or Worker.
// Only the Linux/app-server boundary is substituted; Chat and AIChatAgent are real.
export class TestSandbox extends DurableObject {
  private sockets = new Set<WebSocket>();
  private async state(): Promise<State> {
    return (
      (await this.ctx.storage.get<State>("state")) ?? {
        files: {},
        backupEvents: [],
        running: false,
        launches: 0,
        restores: 0,
        destroys: 0,
        turns: [],
        steers: 0,
      }
    );
  }
  private save(state: State) {
    return this.ctx.storage.put("state", state);
  }
  private emit(method: string, params: object) {
    for (const socket of this.sockets)
      socket.send(JSON.stringify({ method, params }));
  }
  async fetch(request: Request) {
    const state = await this.state();
    if (
      !state.running ||
      state.waitingTool ||
      request.headers.get("Authorization") !==
        `Bearer ${state.files["/tmp/codex-app-server-token"]}`
    )
      return new Response("Unauthorized", { status: 401 });
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.sockets.add(server);
    server.addEventListener("close", () => this.sockets.delete(server));
    server.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data));
      if (!frame.method && frame.id === "approval-call") {
        void this.acceptToolResult(frame.result);
        return;
      }
      void this.rpc(frame.method, frame.params ?? {})
        .then(async (result) => {
          const state = await this.state();
          if (frame.method === "turn/start" && state.dropStartAck) {
            state.dropStartAck = false;
            await this.save(state);
            await this.disconnect();
            return;
          }
          if (
            frame.method === "turn/steer" &&
            state.steerBehavior === "lose-ack"
          ) {
            state.steerBehavior = undefined;
            await this.save(state);
            await this.disconnect();
            return;
          }
          if (frame.id !== undefined)
            server.send(JSON.stringify({ id: frame.id, result }));
        })
        .catch((error) => {
          if (frame.id !== undefined)
            server.send(
              JSON.stringify({
                id: frame.id,
                error: { code: -32000, message: String(error) },
              }),
            );
        });
    });
    return new Response(null, { status: 101, webSocket: client });
  }
  private async rpc(
    method: string,
    params: { threadId?: string; turnId?: string; expectedTurnId?: string },
  ) {
    await this.completeIfDue();
    const state = await this.state();
    const current = state.turns.at(-1);
    switch (method) {
      case "initialize":
        return { userAgent: "fixture" };
      case "initialized":
        return {};
      case "thread/start":
        state.files["/workspace/codex/session"] = "native-thread";
        await this.save(state);
        return { thread: { id: "native-thread", turns: state.turns } };
      case "thread/resume":
      case "thread/read":
        if (!state.files["/workspace/codex/session"])
          throw new Error("Native session missing");
        return { thread: { id: "native-thread", turns: state.turns } };
      case "turn/start": {
        if (current?.status === "inProgress")
          throw new Error("Already running");
        const turn: Turn = {
          id: crypto.randomUUID(),
          status: "inProgress",
          items: [textItem("start", "Started. "), command("inProgress")],
          itemsView: "full",
          error: null,
          startedAt: Date.now() / 1000,
          completedAt: null,
          durationMs: null,
        };
        state.turns.push(turn);
        await this.save(state);
        await this.ctx.storage.setAlarm(Date.now() + 8_000);
        this.emit("turn/started", { threadId: "native-thread", turn });
        this.emit("item/completed", {
          threadId: "native-thread",
          turnId: turn.id,
          item: turn.items[0],
        });
        this.emit("item/started", {
          threadId: "native-thread",
          turnId: turn.id,
          item: turn.items[1],
        });
        return { turn };
      }
      case "turn/steer":
        if (
          state.steerBehavior === "finish" &&
          current?.status === "inProgress"
        ) {
          state.steerBehavior = undefined;
          current.status = "completed";
          await this.save(state);
          this.emit("turn/completed", {
            threadId: "native-thread",
            turn: current,
          });
          throw new Error("No active turn to steer");
        }
        if (state.steerBehavior === "reject") {
          state.steerBehavior = undefined;
          await this.save(state);
          throw new Error("Fixture rejected steering");
        }
        if (
          current?.status !== "inProgress" ||
          current.id !== params.expectedTurnId
        )
          throw new Error("Stale steering");
        state.steers++;
        await this.save(state);
        return { turnId: current.id };
      case "turn/interrupt":
        if (
          current?.status === "inProgress" &&
          current.id === params.turnId &&
          !state.ignoreCancellation
        ) {
          current.status = "interrupted";
          await this.save(state);
          this.emit("turn/completed", {
            threadId: "native-thread",
            turn: current,
          });
        }
        return {};
      default:
        throw new Error(`Unsupported method ${method}`);
    }
  }
  private async completeIfDue() {
    const state = await this.state();
    const turn = state.turns.at(-1);
    if (
      !state.running ||
      state.waitingTool ||
      state.ignoreCancellation ||
      turn?.status !== "inProgress" ||
      Date.now() < turn.startedAt! * 1000 + 8000
    )
      return;
    turn.status = "completed";
    turn.items = [
      textItem("start", "Started. "),
      command("completed"),
      textItem("finish", "Finished."),
    ];
    await this.save(state);
    for (const item of turn.items.slice(1))
      this.emit("item/completed", {
        threadId: "native-thread",
        turnId: turn.id,
        item,
      });
    this.emit("turn/completed", { threadId: "native-thread", turn });
  }
  async alarm() {
    await this.completeIfDue();
  }
  async exists(path: string) {
    return { exists: path in (await this.state()).files };
  }
  async writeFile(path: string, content: string) {
    const state = await this.state();
    state.files[path] = content;
    await this.save(state);
  }
  async readFile(path: string) {
    const content = (await this.state()).files[path];
    if (content === undefined) throw new Error(`Missing fixture file: ${path}`);
    return { content };
  }
  async deleteFile(path: string) {
    const state = await this.state();
    delete state.files[path];
    await this.save(state);
  }
  async exec(command: string) {
    const path = command.match(/ > (\/tmp\/approval-[\w-]+\.patch)$/)?.[1];
    if (path)
      await this.writeFile(
        path,
        "diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-old\n+new\n",
      );
    return {
      success: true,
      stdout:
        "diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-old\n+new\n",
    };
  }
  async requestApproval() {
    const state = await this.state();
    state.waitingTool = true;
    await this.save(state);
    for (const socket of this.sockets)
      socket.send(
        JSON.stringify({
          id: "approval-call",
          method: "item/tool/call",
          params: {
            threadId: "native-thread",
            turnId: state.turns.at(-1)!.id,
            callId: "approval-call",
            namespace: null,
            tool: "push_sync",
            arguments: { baseSha: "a".repeat(40), proposedSha: "b".repeat(40) },
          },
        }),
      );
  }
  private async acceptToolResult(result: unknown) {
    const state = await this.state();
    state.toolResults = [...(state.toolResults ?? []), result];
    state.waitingTool = false;
    await this.save(state);
    await this.ctx.storage.setAlarm(Date.now() + 100);
  }
  async startProcess(_command: string, _options: { processId: string }) {
    const state = await this.state();
    if (state.running) throw new Error("Duplicate launch");
    state.running = true;
    state.launches++;
    await this.save(state);
  }
  async getProcess(id: string) {
    return (await this.state()).running ? { id, status: "running" } : null;
  }
  async cleanupCompletedProcesses() {}
  async setSteerBehavior(behavior: State["steerBehavior"]) {
    const state = await this.state();
    state.steerBehavior = behavior;
    await this.save(state);
  }
  async dropNextStartAck() {
    const state = await this.state();
    state.dropStartAck = true;
    await this.save(state);
  }
  async ignoreCancellation() {
    const state = await this.state();
    state.ignoreCancellation = true;
    await this.save(state);
  }
  async failNextBackup() {
    const state = await this.state();
    state.failBackup = true;
    await this.save(state);
  }
  async createBackup() {
    const state = await this.state();
    if (state.turns.at(-1)?.status === "inProgress" && state.running)
      throw new Error("Checkpoint while turn active");
    if (state.failBackup) {
      state.backupEvents.push("backup-failed");
      state.failBackup = false;
      await this.save(state);
      throw new Error("Fixture R2 unavailable");
    }
    state.backupEvents.push("backup");
    state.backup = Object.fromEntries(
      Object.entries(state.files).filter(([path]) =>
        path.startsWith("/workspace/"),
      ),
    );
    await this.save(state);
    return { id: "test-backup", dir: "/workspace" };
  }
  async restoreBackup() {
    const state = await this.state();
    if (!state.backup) throw new Error("No backup");
    state.files = { ...state.backup };
    state.restores++;
    // The saved native session is idle. Work lost since that checkpoint is not replayed.
    state.turns = state.turns.filter((turn) => turn.status !== "inProgress");
    await this.save(state);
  }
  async disconnect() {
    for (const socket of this.sockets) socket.close(1000, "Fixture disconnect");
    this.sockets.clear();
  }
  async sleep() {
    const state = await this.state();
    state.running = false;
    state.files = {};
    await this.save(state);
    await this.disconnect();
  }
  async failDestroy(attempts: number) {
    const state = await this.state();
    state.destroyFailures = attempts;
    await this.save(state);
  }
  async destroy() {
    const state = await this.state();
    state.destroys++;
    state.backupEvents.push(
      state.destroyFailures ? "destroy-failed" : "destroy",
    );
    if (state.destroyFailures) {
      state.destroyFailures--;
      await this.save(state);
      throw new Error("Fixture destroy unavailable");
    }
    state.files = {};
    state.running = false;
    state.ignoreCancellation = false;
    await this.save(state);
    await this.ctx.storage.deleteAlarm();
    await this.disconnect();
  }
  async backupEvents() {
    return (await this.state()).backupEvents;
  }
  async inspect() {
    const {
      launches,
      restores,
      destroys,
      running,
      steers,
      turns,
      toolResults,
    } = await this.state();
    return {
      launches,
      restores,
      destroys,
      running,
      steers,
      turns: turns.length,
      toolResults,
    };
  }
}
