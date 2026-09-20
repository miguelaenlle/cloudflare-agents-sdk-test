import { DurableObject } from "cloudflare:workers";

// Deterministic Sandbox substitute. Process progress depends on persisted time,
// so replacing either the relay or the Worker does not restart the fake work.
type State = {
  files: Record<string, string>;
  backup?: Record<string, string>;
  process?: { id: string; dir: string; startedAt: number; status: string };
  launches: number;
  restores: number;
  keepAlive: boolean;
  failBackup?: boolean;
  destroyFailures?: number;
  destroys: number;
  ignoreCancellation?: boolean;
};
export class TestSandbox extends DurableObject {
  private listeners = new Set<() => Promise<void>>();

  private async state(): Promise<State> {
    return (
      (await this.ctx.storage.get<State>("state")) ?? {
        files: {},
        destroys: 0,
        launches: 0,
        restores: 0,
        keepAlive: false,
      }
    );
  }
  private save(state: State) {
    return this.ctx.storage.put("state", state);
  }
  async exists(path: string) {
    return { exists: path in (await this.state()).files };
  }
  async writeFile(path: string, content: string) {
    const state = await this.state();
    state.files[path] = content;
    if (
      path === `${state.process?.dir}/cancel` &&
      state.process?.status === "running" &&
      !state.ignoreCancellation
    ) {
      state.process.status = "completed";
      state.files[`${state.process.dir}/result.json`] = JSON.stringify({
        status: "cancelled",
      });
    }
    await this.save(state);
    await Promise.all([...this.listeners].map((notify) => notify()));
  }
  async readFile(path: string) {
    const content = (await this.state()).files[path];
    if (content === undefined) throw new Error(`Missing fixture file: ${path}`);
    return { content };
  }
  async mkdir() {}
  async exec() {
    return { success: true };
  }
  async setKeepAlive(keepAlive: boolean) {
    const state = await this.state();
    state.keepAlive = keepAlive;
    await this.save(state);
  }
  async startProcess(_command: string, options: { processId: string }) {
    const state = await this.state();
    const dir = `/tmp/codex-runs/${options.processId}`;
    if (state.process?.id === options.processId)
      throw new Error("Duplicate launch");
    const input = JSON.parse(state.files[`${dir}/input.json`]);
    if (state.launches > 0 && input.threadId !== "native-thread")
      throw new Error("Native thread was not resumed");
    if (input.threadId && !state.files["/workspace/codex/session"])
      throw new Error("Session files were not restored");
    state.files["/workspace/codex/session"] = "native-thread";
    state.files[`${dir}/thread-id`] = "native-thread";
    state.files[`${dir}/events.jsonl`] =
      [
        { type: "thread.started", thread_id: "native-thread" },
        {
          type: "item.completed",
          item: { id: "start", type: "agent_message", text: "Started. " },
        },
        {
          type: "item.started",
          item: { id: "cmd", type: "command_execution", command: "sleep 8" },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n";
    state.process = {
      id: options.processId,
      dir,
      startedAt: Date.now(),
      status: "running",
    };
    state.launches++;
    await this.save(state);
  }
  async getProcess(id: string) {
    const state = await this.state();
    const process = state.process;
    if (!process || process.id !== id) return null;
    if (
      process.status === "running" &&
      Date.now() - process.startedAt >= 8000
    ) {
      process.status = "completed";
      state.files[`${process.dir}/events.jsonl`] +=
        [
          {
            type: "item.completed",
            item: {
              id: "cmd",
              type: "command_execution",
              command: "sleep 8",
              exit_code: 0,
              aggregated_output: "done",
            },
          },
          {
            type: "item.completed",
            item: { id: "finish", type: "agent_message", text: "Finished." },
          },
          { type: "turn.completed" },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n") + "\n";
      state.files[`${process.dir}/result.json`] = JSON.stringify({
        status: "completed",
      });
      await this.save(state);
    }
    return { id, status: process.status };
  }
  async streamProcessLogs(id: string) {
    const state = await this.state();
    const process = state.process;
    if (!process || process.id !== id) throw new Error("No fixture process");
    let offset = 0;
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    let notify: () => Promise<void>;
    const cleanup = () => {
      closed = true;
      clearTimeout(timer);
      this.listeners.delete(notify);
    };
    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const send = (type: string, data: string) =>
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ type, data, processId: id })}\n\n`,
            ),
          );
        notify = async () => {
          const current = await this.getProcess(id);
          const state = await this.state();
          if (closed) return;
          const stdout = state.files[`${process.dir}/events.jsonl`] ?? "";
          if (stdout.length > offset) send("stdout", stdout.slice(offset));
          offset = stdout.length;
          if (current?.status !== "running") {
            send("exit", "");
            cleanup();
            controller.close();
          }
        };
        this.listeners.add(notify);
        timer = setTimeout(
          () => void notify(),
          Math.max(0, process.startedAt + 8000 - Date.now()),
        );
        await notify();
      },
      cancel: cleanup,
    });
  }
  async killProcess(id: string) {
    const state = await this.state();
    if (state.process?.id === id) {
      state.process.status = "killed";
      await this.save(state);
      await Promise.all([...this.listeners].map((notify) => notify()));
    }
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
    if (state.process?.status === "running")
      throw new Error("Checkpoint attempted before process stopped");
    if (state.failBackup) {
      state.failBackup = false;
      await this.save(state);
      throw new Error("Fixture R2 unavailable");
    }
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
    await this.save(state);
  }
  async sleep() {
    const state = await this.state();
    state.keepAlive = false;
    state.files = {};
    delete state.process;
    await this.save(state);
  }
  async failDestroy(attempts: number) {
    const state = await this.state();
    state.destroyFailures = attempts;
    await this.save(state);
  }
  async destroy() {
    const state = await this.state();
    state.destroys++;
    if (state.destroyFailures) {
      state.destroyFailures--;
      await this.save(state);
      throw new Error("Fixture destroy unavailable");
    }
    state.files = {};
    delete state.process;
    state.keepAlive = false;
    await this.save(state);
    await Promise.all([...this.listeners].map((notify) => notify()));
  }
  async inspect() {
    const { launches, restores, keepAlive, destroys } = await this.state();
    return { launches, restores, keepAlive, destroys };
  }
}
