import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { getSandbox, Sandbox } from "@cloudflare/sandbox";
import { routeAgentRequest } from "agents";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import {
  checkpointCodex,
  SANDBOX_IDLE_MS,
  SANDBOX_LIFETIME_MS,
  observeCodex,
  prepareSandbox,
  sandboxThread,
  startCodex,
  stopCodex,
  type CodexState,
  type Run,
} from "./codex.ts";

export { Sandbox };
interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  Chat: DurableObjectNamespace<Chat>;
  CODEX_API_KEY: string;
  CODEX_MODEL?: string;
  UI_ORIGIN: string;
}

type Expiration = {
  id: string;
  reason: "idle" | "lifetime";
  waitingSince?: number;
  attempt?: number;
};
const MAX_CLEANUP_ATTEMPTS = 3;
const stopOutcomes = {
  cancelled: { status: "cancelled", message: "Task cancelled." },
  interrupted: {
    status: "interrupted",
    message:
      "Task interrupted. It was not automatically repeated. You can send another message to continue.",
  },
  expired: {
    status: "interrupted",
    message:
      "Sandbox reached its six-hour lifetime limit. Send another message to restore the last checkpoint.",
  },
} as const;

export class Chat extends AIChatAgent<Env, CodexState> {
  initialState: CodexState = {};
  private runFinished?: Promise<void>;
  private runAbort?: AbortController;
  private interruption?: Promise<void>;

  protected now() {
    return Date.now();
  }

  protected sandbox(id: string) {
    return getSandbox(this.env.Sandbox, id, { sleepAfter: "6h" });
  }

  private canUseSandbox(id: string) {
    const sandbox = this.state.sandbox;
    return (
      sandbox?.id === id &&
      !["destroying", "cleanup_failed"].includes(sandbox.phase)
    );
  }

  protected override async onChatRecovery() {
    try {
      await this.interruptRun("interrupted");
    } catch (error) {
      throw new Error(this.errorMessage(error));
    }
    return { persist: false, continue: false };
  }

  override async onRequest(request: Request) {
    if (
      request.method === "POST" &&
      new URL(request.url).pathname.endsWith("/cancel")
    ) {
      try {
        await this.interruptRun("cancelled");
      } catch (error) {
        return Response.json(
          { error: this.errorMessage(error) },
          { status: 503 },
        );
      }
      return new Response(null, { status: 204 });
    }
    return super.onRequest(request);
  }

  private async saveCheckpoint(run: Run) {
    const sandbox = this.sandbox(run.sandboxId);
    if (
      !(await sandbox.exists("/tmp/codex-ready")).exists ||
      !this.canUseSandbox(run.sandboxId)
    )
      return;
    const threadId = await sandboxThread(sandbox, run, this.state.threadId);
    if (!this.canUseSandbox(run.sandboxId)) return;
    this.setState({ ...this.state, threadId });
    const backup = await checkpointCodex(sandbox);
    // A hard expiry can destroy this generation while backup is in flight.
    if (this.canUseSandbox(run.sandboxId)) {
      this.setState({ ...this.state, checkpoint: { backup, threadId } });
    }
  }

  private async finishRun(run: Run, status: Run["status"]) {
    if (!this.canUseSandbox(run.sandboxId)) return;
    await stopCodex(this.sandbox(run.sandboxId), run);
    if (!this.canUseSandbox(run.sandboxId)) return;
    try {
      await this.saveCheckpoint(run);
    } catch (error) {
      status = "failed";
      throw error;
    } finally {
      if (this.canUseSandbox(run.sandboxId)) {
        const reason = this.state.run?.stopReason;
        const waitingSince = this.now();
        this.setState({
          ...this.state,
          run: {
            ...this.state.run!,
            status: reason ? stopOutcomes[reason].status : status,
          },
          sandbox: {
            ...this.state.sandbox!,
            phase: "waiting_for_user",
            waitingSince,
          },
        });
        // Keep the container warm until explicit suspension, not infrastructure inactivity.
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

  private errorMessage(error: unknown) {
    const message = error instanceof Error ? error.message : "Codex failed.";
    return this.env.CODEX_API_KEY
      ? message.split(this.env.CODEX_API_KEY).join("[REDACTED]")
      : message;
  }

  private async interruptRun(reason: "cancelled" | "interrupted") {
    const run = this.state.run;
    if (run?.status !== "running") return;
    if (!this.canUseSandbox(run.sandboxId))
      throw new Error("Sandbox cleanup is pending.");
    this.setState({ ...this.state, run: { ...run, stopReason: reason } });
    if (this.interruption) return this.interruption;
    this.interruption = (async () => {
      if (this.runFinished) {
        await stopCodex(this.sandbox(run.sandboxId), run);
        await this.runFinished;
        if (this.state.run?.status === "running") {
          throw new Error("Cleanup is pending; another turn cannot start yet.");
        }
        return;
      }
      let checkpointError = "";
      try {
        await this.finishRun(run, stopOutcomes[reason].status);
      } catch (error) {
        if (this.state.run?.status === "running") throw error;
        checkpointError = ` Checkpoint failed: ${this.errorMessage(error)}`;
      }
      await this.persistOutcome(
        run,
        stopOutcomes[reason].message + checkpointError,
      );
    })();
    try {
      await this.interruption;
    } finally {
      this.interruption = undefined;
    }
  }

  private async persistOutcome(run: Run, text: string) {
    const id = `codex-${run.id}`;
    await this.persistMessages([
      ...this.messages.filter((message) => message.id !== id),
      { id, role: "assistant", parts: [{ type: "text", text }] },
    ]);
  }

  // Idle: waiting_for_user → suspending → offline, only after a successful backup.
  // Lifetime: any state → destroying → offline, even if the latest turn cannot be saved.
  async expireSandbox(expiration: Expiration) {
    const { id, reason, waitingSince, attempt = 0 } = expiration;
    const lifecycle = this.state.sandbox;
    if (lifecycle?.id !== id) return;
    if (
      reason === "idle" &&
      (lifecycle.phase !== "waiting_for_user" ||
        lifecycle.waitingSince !== waitingSince ||
        waitingSince === undefined ||
        this.now() < waitingSince + SANDBOX_IDLE_MS)
    )
      return;
    if (
      reason === "lifetime" &&
      this.now() < lifecycle.createdAt + SANDBOX_LIFETIME_MS
    )
      return;

    const run = this.state.run;
    const wasStreaming = Boolean(this.runFinished);
    this.setState({
      ...this.state,
      sandbox: {
        ...lifecycle,
        phase: reason === "idle" ? "suspending" : "destroying",
      },
      run: run?.status === "running" ? { ...run, stopReason: "expired" } : run,
    });
    if (reason === "lifetime")
      this.runAbort?.abort(new Error(stopOutcomes.expired.message));
    const sandbox = this.sandbox(id);
    try {
      if (reason === "idle") {
        if (run) await this.saveCheckpoint(run);
        if (!this.canUseSandbox(id)) return;
        this.setState({
          ...this.state,
          sandbox: { ...this.state.sandbox!, phase: "destroying" },
        });
      }
      // Disable keep-alive even if destroy fails; there is no infinite cleanup loop.
      try {
        await sandbox.setKeepAlive(false);
      } catch (error) {
        console.error(
          "Could not release sandbox keep-alive",
          this.errorMessage(error),
        );
      }
      await sandbox.destroy();
      if (this.state.sandbox?.id !== id) return;
      const interrupted = this.state.run?.status === "running";
      this.setState({
        ...this.state,
        sandbox: undefined,
        threadId: this.state.checkpoint?.threadId,
        run: interrupted
          ? { ...this.state.run!, status: "interrupted" }
          : this.state.run,
      });
      if (interrupted && !wasStreaming)
        await this.persistOutcome(run!, stopOutcomes.expired.message);
    } catch (error) {
      console.error("Sandbox cleanup failed", this.errorMessage(error));
      if (this.state.sandbox?.id !== id) return;
      // Hard expiry takes priority over an idle backup that finishes late.
      if (
        reason === "idle" &&
        this.now() >= lifecycle.createdAt + SANDBOX_LIFETIME_MS
      )
        return;
      this.setState({
        ...this.state,
        sandbox: {
          ...this.state.sandbox,
          phase: reason === "idle" ? "waiting_for_user" : "cleanup_failed",
        },
      });
      if (attempt + 1 < MAX_CLEANUP_ATTEMPTS) {
        await this.schedule(30, "expireSandbox", {
          ...expiration,
          attempt: attempt + 1,
        });
      }
    }
  }

  override async onChatMessage(
    _onFinish: Parameters<AIChatAgent<Env>["onChatMessage"]>[0],
    options?: OnChatMessageOptions,
  ) {
    const message = [...this.messages]
      .reverse()
      .find((message) => message.role === "user");
    const prompt = message?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (!message || !prompt) throw new Error("Send a text prompt to Codex.");
    if (!this.env.CODEX_API_KEY)
      throw new Error("Set the CODEX_API_KEY Worker secret first.");
    if (this.runFinished) {
      throw new Error("The previous Codex run is still active.");
    }
    if (this.state.run?.messageId === message.id) {
      throw new Error(
        "This turn was already attempted. Send a new message to continue.",
      );
    }
    const existing = this.state.sandbox;
    if (existing && this.now() >= existing.createdAt + SANDBOX_LIFETIME_MS) {
      await this.expireSandbox({
        id: existing.id,
        reason: "lifetime",
        attempt: MAX_CLEANUP_ATTEMPTS - 1,
      });
      if (this.state.sandbox)
        throw new Error("Sandbox cleanup failed. Try again later.");
    }
    if (this.state.run?.status === "running") {
      throw new Error("The previous Codex run is still active.");
    }
    if (this.state.sandbox && this.state.sandbox.phase !== "waiting_for_user") {
      throw new Error("Sandbox cleanup is pending. Try again shortly.");
    }

    const isNew = !this.state.sandbox;
    const lifecycle = this.state.sandbox ?? {
      id: crypto.randomUUID(),
      createdAt: this.now(),
      phase: "starting" as const,
    };
    const run: Run = {
      id: crypto.randomUUID(),
      messageId: message.id,
      sandboxId: lifecycle.id,
      startedAt: this.now(),
      status: "running",
    };
    this.setState({
      ...this.state,
      run,
      sandbox: {
        ...lifecycle,
        phase: isNew ? "starting" : "waiting_for_agent",
        waitingSince: undefined,
      },
    });
    let resolveRun!: () => void;
    this.runFinished = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    const abort = new AbortController();
    this.runAbort = abort;
    const signal = options?.abortSignal
      ? AbortSignal.any([abort.signal, options.abortSignal])
      : abort.signal;

    return createUIMessageStreamResponse({
      stream: createUIMessageStream({
        onError: (error) => this.errorMessage(error),
        execute: async ({ writer }) => {
          const sandbox = this.sandbox(lifecycle.id);
          let failure: unknown;
          let status: Run["status"] = "completed";
          writer.write({ type: "start", messageId: `codex-${run.id}` });
          try {
            try {
              if (isNew) {
                // Persist the lifetime deadline before starting any paid work.
                try {
                  await this.schedule(
                    new Date(
                      Math.ceil(
                        (lifecycle.createdAt + SANDBOX_LIFETIME_MS) / 1000,
                      ) * 1000,
                    ),
                    "expireSandbox",
                    {
                      id: lifecycle.id,
                      reason: "lifetime",
                    } satisfies Expiration,
                  );
                } catch (error) {
                  this.setState({
                    ...this.state,
                    sandbox: undefined,
                    run: { ...run, status: "failed" },
                  });
                  throw error;
                }
              }
              abort.signal.throwIfAborted();
              await sandbox.setKeepAlive(true);
              abort.signal.throwIfAborted();
              const threadId = await prepareSandbox(sandbox, this.state);
              abort.signal.throwIfAborted();
              this.setState({
                ...this.state,
                threadId,
                sandbox: { ...this.state.sandbox!, phase: "waiting_for_agent" },
              });
              if (!this.state.run?.stopReason) {
                await startCodex(sandbox, run, {
                  prompt,
                  threadId,
                  model: this.env.CODEX_MODEL,
                  apiKey: this.env.CODEX_API_KEY,
                  expiresAt: lifecycle.createdAt + SANDBOX_LIFETIME_MS,
                });
                abort.signal.throwIfAborted();
                if (this.state.run?.stopReason) await stopCodex(sandbox, run);
                const result = await observeCodex(
                  sandbox,
                  run,
                  (chunk) => writer.write(chunk),
                  signal,
                );
                status = result.status;
                if (result.error) failure = new Error(result.error);
              }
            } catch (error) {
              failure = error;
              status = "failed";
            }
            let cleanupFailed = false;
            try {
              await this.finishRun(run, status);
            } catch (error) {
              cleanupFailed = true;
              failure = error;
            }
            const reason = this.state.run?.stopReason;
            if (reason) {
              status = stopOutcomes[reason].status;
              // Stop must not hide an unconfirmed exit or a failed checkpoint.
              if (!cleanupFailed || reason === "expired") {
                failure =
                  reason === "cancelled"
                    ? undefined
                    : new Error(stopOutcomes[reason].message);
              }
            }
            if (failure) {
              const id = `${run.id}:error`;
              writer.write({ type: "text-start", id });
              writer.write({
                type: "text-delta",
                id,
                delta: `Task failed: ${this.errorMessage(failure)}`,
              });
              writer.write({ type: "text-end", id });
            } else if (status === "cancelled") {
              writer.write({ type: "abort" });
            }
            writer.write({
              type: "finish",
              finishReason: failure ? "error" : "stop",
            });
          } finally {
            this.runFinished = undefined;
            this.runAbort = undefined;
            resolveRun();
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
