import { AIChatAgent } from "@cloudflare/ai-chat";
import { getSandbox, ContainerProxy } from "@cloudflare/sandbox";
import { routeAgentRequest } from "agents";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessageChunk,
} from "ai";
import { steerRequestSchema } from "@playground/chat-contract";
import { AppServer, within } from "./app-server.ts";
import { Sandbox } from "./sandbox.ts";
import { CodexEvents } from "./codex-events.ts";
import {
  checkpointCodex,
  connectCodex,
  ContainerLost,
  SANDBOX_IDLE_MS,
  USER_IDLE_MS,
  type CodexSandbox,
  type CodexState,
  type Run,
} from "./codex.ts";
import type { Turn } from "./protocol.ts";

export { Sandbox, ContainerProxy };
interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  Chat: DurableObjectNamespace<Chat>;
  CODEX_MODEL?: string;
  UI_ORIGIN: string;
}
type Expiration = {
  id: string;
  reason: "idle" | "interaction" | "retry";
  waitingSince?: number;
  attempt?: number;
};
const MAX_CLEANUP_ATTEMPTS = 3;
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "Codex failed.";
const expiredMessage =
  "No user interaction for six hours. Sandbox cleanup started; another turn must wait for confirmed destruction.";
const interruptedMessage =
  "Task interrupted. It was not automatically repeated. You can send another message to continue.";

export class Chat extends AIChatAgent<Env, CodexState> {
  initialState: CodexState = {};
  private active?: { client: AppServer; completed: Promise<Turn> };
  private turnInProgress = false;
  private controlPending = false;
  private recovery?: Promise<void>;

  protected now() {
    return Date.now();
  }
  protected sandbox(id: string): CodexSandbox {
    return getSandbox(this.env.Sandbox, id, {
      keepAlive: false,
      sleepAfter: "6h",
    });
  }
  private usable(id: string) {
    return (
      this.state.sandbox?.id === id &&
      !["destroying", "cleanup_failed"].includes(this.state.sandbox.phase)
    );
  }
  private ensureUsable(id: string) {
    if (!this.usable(id)) throw new Error("Sandbox cleanup is pending.");
  }
  private setRun(run: Run) {
    if (this.state.run?.id === run.id && this.usable(run.sandboxId))
      this.setState({ ...this.state, run });
  }

  private async interaction() {
    const sandbox = this.state.sandbox!;
    this.ensureUsable(sandbox.id);
    const at = this.now();
    const schedule = await this.schedule(
      new Date(Math.ceil((at + USER_IDLE_MS) / 1000) * 1000),
      "expireSandbox",
      { id: sandbox.id, reason: "interaction" } satisfies Expiration,
    );
    this.ensureUsable(sandbox.id);
    this.setState({
      ...this.state,
      sandbox: {
        ...this.state.sandbox!,
        lastUserInteractionAt: at,
        deadlineSchedule: schedule.id,
      },
    });
    if (sandbox.deadlineSchedule)
      await this.cancelSchedule(sandbox.deadlineSchedule);
  }

  override async onRequest(request: Request) {
    const path = new URL(request.url).pathname;
    if (
      request.method !== "POST" ||
      (!path.endsWith("/cancel") && !path.endsWith("/steer"))
    )
      return super.onRequest(request);
    if (this.controlPending)
      return Response.json(
        { error: "A control request is already pending." },
        { status: 409 },
      );
    this.controlPending = true;
    try {
      const run = this.state.run;
      if (path.endsWith("/steer")) {
        const parsed = steerRequestSchema.safeParse(await request.json());
        if (!parsed.success)
          return Response.json(
            { error: "Invalid steering request." },
            { status: 400 },
          );
        const input = parsed.data;
        if (
          run?.status !== "running" ||
          run.id !== input.runId ||
          !run.turnId ||
          !run.threadId ||
          !this.active
        ) {
          return Response.json(
            {
              error:
                "That turn is no longer available for steering. Send a new message.",
            },
            { status: 409 },
          );
        }
        if (this.messages.some((message) => message.id === input.id))
          return new Response(null, { status: 204 });
        this.ensureUsable(run.sandboxId);
        await this.active.client.request("turn/steer", {
          threadId: run.threadId,
          expectedTurnId: run.turnId,
          clientUserMessageId: input.id,
          input: [{ type: "text", text: input.text, text_elements: [] }],
        });
        await this.interaction();
        await this.persistMessages([
          ...this.messages,
          {
            id: input.id,
            role: "user",
            parts: [{ type: "text", text: input.text }],
          },
        ]);
        return new Response(null, { status: 204 });
      }
      if (run?.status === "running") {
        this.ensureUsable(run.sandboxId);
        const active = this.active;
        if (active && run.threadId && run.turnId) {
          await active.client.request("turn/interrupt", {
            threadId: run.threadId,
            turnId: run.turnId,
          });
          await this.interaction();
          await within(
            active.completed,
            5_000,
            "Stop is unconfirmed. Another turn remains blocked.",
          );
        } else if (this.turnInProgress) {
          return Response.json(
            { error: "Codex is still starting. Try Stop again shortly." },
            { status: 409 },
          );
        } else {
          await this.reconcile();
        }
      }
      return new Response(null, { status: 204 });
    } catch (error) {
      return Response.json({ error: messageOf(error) }, { status: 503 });
    } finally {
      this.controlPending = false;
    }
  }

  protected override async onChatRecovery() {
    await this.reconcile();
    return { persist: false, continue: false };
  }

  private async checkpoint(id: string) {
    const sandbox = this.sandbox(id);
    if (!(await sandbox.exists("/tmp/codex-app-server-ready")).exists)
      throw new ContainerLost();
    this.ensureUsable(id);
    const threadId = this.state.threadId;
    const backup = await checkpointCodex(sandbox);
    if (this.usable(id))
      this.setState({ ...this.state, checkpoint: { backup, threadId } });
  }

  private async finishRun(run: Run, status: Run["status"]) {
    if (!this.usable(run.sandboxId)) return;
    try {
      await this.checkpoint(run.sandboxId);
    } catch (error) {
      status = "failed";
      throw error;
    } finally {
      if (this.usable(run.sandboxId)) {
        const waitingSince = this.now();
        this.setState({
          ...this.state,
          run: { ...this.state.run!, status },
          sandbox: {
            ...this.state.sandbox!,
            phase: "waiting_for_user",
            waitingSince,
          },
        });
        await this.schedule(
          new Date(Math.ceil((waitingSince + SANDBOX_IDLE_MS) / 1000) * 1000),
          "expireSandbox",
          {
            id: run.sandboxId,
            reason: "idle",
            waitingSince,
          } satisfies Expiration,
        );
      }
    }
  }

  // After connection/DO loss, stop surviving work before allowing another prompt.
  // A missing acknowledgment never causes an automatic replay of turn/start.
  private reconcile(): Promise<void> {
    if (this.recovery) return this.recovery;
    this.recovery = this.reconcileRun().finally(() => {
      this.recovery = undefined;
    });
    return this.recovery;
  }
  private async reconcileRun() {
    const run = this.state.run;
    if (run?.status !== "running" || this.active) return;
    this.ensureUsable(run.sandboxId);
    let client: AppServer | undefined;
    let outcome = interruptedMessage;
    let status: Run["status"] = "interrupted";
    try {
      const connection = await connectCodex(
        this.sandbox(run.sandboxId),
        this.state,
        {
          recovery: true,
          assertCurrent: () => this.ensureUsable(run.sandboxId),
        },
      );
      client = connection.client;
      if (run.threadId) {
        const { thread } = await client.request("thread/resume", {
          threadId: run.threadId,
        });
        const turn = thread.turns.find((turn) => turn.status === "inProgress");
        if (turn) {
          let resolve!: (turn: Turn) => void;
          const done = new Promise<Turn>((r) => {
            resolve = r;
          });
          const unsubscribe = client.subscribe((event) => {
            if (
              event.method === "turn/completed" &&
              event.params.threadId === run.threadId &&
              event.params.turn.id === turn.id
            )
              resolve(event.params.turn);
          });
          try {
            await client.request("turn/interrupt", {
              threadId: run.threadId,
              turnId: turn.id,
            });
            await within(
              Promise.race([done, client.disconnected]),
              5_000,
              "Recovery could not confirm Stop.",
            );
          } finally {
            unsubscribe();
          }
        }
        // Inspect again after interruption: do not infer completion from the RPC acknowledgment.
        const current = (
          await client.request("thread/read", {
            threadId: run.threadId,
            includeTurns: true,
          })
        ).thread;
        if (current.turns.some((turn) => turn.status === "inProgress"))
          throw new Error("Codex is still active.");
        const completed = current.turns.find((turn) => turn.id === run.turnId);
        if (completed?.status === "completed") {
          status = "completed";
          outcome =
            completed.items
              .filter((item) => item.type === "agentMessage")
              .map((item) => item.text)
              .join("\n") || "Turn completed before reconnection.";
        } else if (completed?.status === "failed") {
          status = "failed";
          outcome = `Task failed: ${completed.error?.message ?? "Codex turn failed."}`;
        }
      }
      await this.finishRun(run, status);
    } catch (error) {
      if (!(error instanceof ContainerLost)) throw error;
      // No surviving execution, but the old generation must still be cleaned up.
      await this.destroyGeneration(run.sandboxId);
      outcome = error.message;
    } finally {
      client?.close();
    }
    await this.persistMessages([
      ...this.messages.filter((message) => message.id !== `codex-${run.id}`),
      {
        id: `codex-${run.id}`,
        role: "assistant",
        parts: [{ type: "text", text: outcome }],
      },
    ]);
  }

  private async destroyGeneration(id: string) {
    if (this.state.sandbox?.id !== id) return;
    this.setState({
      ...this.state,
      sandbox: { ...this.state.sandbox, phase: "destroying" },
    });
    this.active?.client.close();
    try {
      await within(
        this.sandbox(id).destroy(),
        30_000,
        "Sandbox destruction unconfirmed.",
      );
      if (this.state.sandbox?.id !== id) return;
      this.setState({
        ...this.state,
        sandbox: undefined,
        threadId: this.state.checkpoint?.threadId,
        run:
          this.state.run?.status === "running"
            ? { ...this.state.run, status: "interrupted" }
            : this.state.run,
      });
    } catch (error) {
      if (this.state.sandbox?.id === id)
        this.setState({
          ...this.state,
          sandbox: { ...this.state.sandbox, phase: "cleanup_failed" },
        });
      throw error;
    }
  }

  async expireSandbox(expiration: Expiration) {
    const { id, reason, attempt = 0 } = expiration;
    // A deployment can leave callbacks from the old absolute-lifetime policy.
    if (!["idle", "interaction", "retry"].includes(reason)) return;
    const state = this.state.sandbox;
    if (!state || state.id !== id) return;
    if (
      reason === "idle" &&
      (state.phase !== "waiting_for_user" ||
        state.waitingSince !== expiration.waitingSince ||
        this.now() < (state.waitingSince ?? this.now()) + SANDBOX_IDLE_MS)
    )
      return;
    if (
      reason === "interaction" &&
      this.now() < state.lastUserInteractionAt + USER_IDLE_MS
    )
      return;
    if (reason === "retry" && state.phase !== "cleanup_failed") return;
    let checkpointOnly = reason === "idle";
    try {
      if (reason === "idle") {
        this.setState({
          ...this.state,
          sandbox: { ...state, phase: "suspending" },
        });
        await this.checkpoint(id);
        if (!this.usable(id)) return;
      } else if (reason === "interaction") {
        this.setState({
          ...this.state,
          sandbox: { ...state, phase: "destroying" },
        });
        const active = this.active;
        const run = this.state.run;
        try {
          if (active && run?.threadId && run.turnId) {
            await within(
              active.client
                .request("turn/interrupt", {
                  threadId: run.threadId,
                  turnId: run.turnId,
                })
                .then(() => active.completed),
              5_000,
              "Deadline Stop timed out.",
            );
            const backup = await within(
              checkpointCodex(this.sandbox(id)),
              10_000,
              "Deadline checkpoint timed out.",
            );
            if (this.state.sandbox?.id === id)
              this.setState({
                ...this.state,
                checkpoint: { backup, threadId: this.state.threadId },
              });
          }
        } catch {
          /* Expiration must not wait indefinitely for a final checkpoint. */
        }
      }
      checkpointOnly = false;
      await this.destroyGeneration(id);
    } catch (error) {
      console.error("Sandbox cleanup failed:", messageOf(error));
      if (this.state.sandbox?.id !== id) return;
      if (checkpointOnly) {
        if (!this.usable(id)) return;
        this.setState({
          ...this.state,
          sandbox: { ...this.state.sandbox, phase: "waiting_for_user" },
        });
      }
      if (attempt + 1 < MAX_CLEANUP_ATTEMPTS)
        await this.schedule(30, "expireSandbox", {
          ...expiration,
          reason: checkpointOnly ? "idle" : "retry",
          attempt: attempt + 1,
        });
    }
  }

  override async onChatMessage() {
    const message = this.messages.findLast(
      (message) => message.role === "user",
    );
    const prompt = message?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (!message || !prompt) throw new Error("Send a text prompt to Codex.");
    if (this.turnInProgress || this.controlPending)
      throw new Error("The previous Codex run is still active.");
    if (this.state.run?.messageId === message.id)
      throw new Error("This prompt was already attempted. Send a new message.");
    const old = this.state.sandbox;
    if (
      old &&
      (old.phase === "cleanup_failed" ||
        this.now() >= old.lastUserInteractionAt + USER_IDLE_MS)
    ) {
      await this.expireSandbox({
        id: old.id,
        reason: old.phase === "cleanup_failed" ? "retry" : "interaction",
        attempt: MAX_CLEANUP_ATTEMPTS - 1,
      });
      if (this.state.sandbox) throw new Error("Sandbox cleanup is pending.");
    }
    if (this.state.run?.status === "running") await this.reconcile();
    if (this.state.sandbox && this.state.sandbox.phase !== "waiting_for_user")
      throw new Error("Sandbox cleanup is pending.");
    const sandbox = this.state.sandbox ?? {
      id: crypto.randomUUID(),
      phase: "starting" as const,
      lastUserInteractionAt: this.now(),
    };
    const run: Run = {
      id: crypto.randomUUID(),
      messageId: message.id,
      sandboxId: sandbox.id,
      status: "running",
    };
    this.setState({
      ...this.state,
      run,
      sandbox: {
        ...sandbox,
        phase: this.state.sandbox ? "waiting_for_agent" : "starting",
        waitingSince: undefined,
      },
    });
    this.turnInProgress = true;
    try {
      await this.interaction();
    } catch (error) {
      this.setState({
        ...this.state,
        run: { ...run, status: "failed" },
        sandbox: {
          ...this.state.sandbox!,
          phase: "waiting_for_user",
          waitingSince: this.now(),
        },
      });
      this.turnInProgress = false;
      throw error;
    }
    return createUIMessageStreamResponse({
      stream: createUIMessageStream({
        onError: messageOf,
        execute: async ({ writer }) => {
          const write = (chunk: UIMessageChunk) => writer.write(chunk);
          const events = new CodexEvents(write, run.id);
          let client: AppServer | undefined;
          let unsubscribe = () => {};
          let terminal = false;
          let failure: unknown;
          let status: Run["status"] = "failed";
          write({
            type: "start",
            messageId: `codex-${run.id}`,
            messageMetadata: { runId: run.id },
          });
          try {
            const connected = await connectCodex(
              this.sandbox(sandbox.id),
              this.state,
              { assertCurrent: () => this.ensureUsable(sandbox.id) },
            );
            client = connected.client;
            this.ensureUsable(sandbox.id);
            const options = {
              cwd: "/workspace/repo",
              approvalPolicy: "never" as const,
              sandbox: "workspace-write" as const,
              model: this.env.CODEX_MODEL,
            };
            const { thread } = connected.threadId
              ? await client.request("thread/resume", {
                  ...options,
                  threadId: connected.threadId,
                })
              : await client.request("thread/start", options);
            this.ensureUsable(sandbox.id);
            if (thread.turns.some((turn) => turn.status === "inProgress"))
              throw new Error("Native thread still has an active turn.");
            this.setState({
              ...this.state,
              threadId: thread.id,
              run: { ...run, threadId: thread.id },
              sandbox: { ...this.state.sandbox!, phase: "waiting_for_agent" },
            });
            let resolve!: (turn: Turn) => void;
            const result = new Promise<Turn>((r) => {
              resolve = r;
            });
            const completed = Promise.race([result, client.disconnected]);
            void completed.catch(() => {});
            this.active = { client, completed };
            unsubscribe = client.subscribe((event) => {
              if (event.params.threadId !== thread.id) return;
              if (event.method === "turn/started") {
                this.setRun({
                  ...this.state.run!,
                  turnId: event.params.turn.id,
                });
              } else if (event.method === "turn/completed") {
                if (
                  !this.state.run?.turnId ||
                  event.params.turn.id === this.state.run.turnId
                )
                  resolve(event.params.turn);
              } else if (event.params.turnId === this.state.run?.turnId)
                events.accept(event);
            });
            this.setRun({ ...this.state.run!, submitted: true });
            const started = await client.request("turn/start", {
              threadId: thread.id,
              clientUserMessageId: message.id,
              input: [{ type: "text", text: prompt, text_elements: [] }],
            });
            this.setRun({ ...this.state.run!, turnId: started.turn.id });
            const turn = await completed;
            terminal = true;
            for (const item of turn.items) events.item(item);
            status =
              turn.status === "completed"
                ? "completed"
                : turn.status === "interrupted"
                  ? "cancelled"
                  : "failed";
            if (status === "failed")
              failure = new Error(turn.error?.message ?? "Codex turn failed.");
            if (this.usable(run.sandboxId)) await this.finishRun(run, status);
          } catch (error) {
            failure = error;
            // Failed submission/transport may still have started work. Leave it running in durable state for reconciliation.
            if (!this.state.run?.submitted && this.usable(run.sandboxId)) {
              try {
                await this.finishRun(run, "failed");
              } catch {
                /* Keep the original startup error. */
              }
            }
          } finally {
            events.finish();
            unsubscribe();
            client?.close();
            this.active = undefined;
            if (!this.usable(run.sandboxId))
              failure = new Error(expiredMessage);
            if (failure) {
              const id = `${run.id}:error`;
              write({ type: "text-start", id });
              write({
                type: "text-delta",
                id,
                delta: `Task failed: ${messageOf(failure)}`,
              });
              write({ type: "text-end", id });
            } else if (terminal && status === "cancelled")
              write({ type: "abort" });
            write({ type: "finish", finishReason: failure ? "error" : "stop" });
            this.turnInProgress = false;
          }
        },
      }),
    });
  }
}
export default {
  async fetch(request, env) {
    // Only the chat is public; the Sandbox binding is an internal execution API.
    if (!new URL(request.url).pathname.startsWith("/agents/chat/")) {
      return new Response("Not found", { status: 404 });
    }
    // CORS covers history requests; WebSocket upgrades need an origin check too.
    const origin = request.headers.get("Origin");
    if (origin && origin !== env.UI_ORIGIN) {
      return new Response("Origin not allowed", { status: 403 });
    }
    return (
      (await routeAgentRequest(request, env, {
        cors: {
          "Access-Control-Allow-Origin": env.UI_ORIGIN,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          Vary: "Origin",
        },
      })) ?? new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
