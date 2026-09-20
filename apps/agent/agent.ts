import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { getSandbox, Sandbox } from "@cloudflare/sandbox";
import { routeAgentRequest } from "agents";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import {
  checkpointCodex,
  forceStopCodex,
  MAX_RUN_MS,
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

const stopOutcomes = {
  cancelled: { status: "cancelled", message: "Task cancelled." },
  interrupted: {
    status: "interrupted",
    message:
      "Task interrupted. It was not automatically repeated. You can send another message to continue.",
  },
  deadline: {
    status: "failed",
    message: "Codex exceeded the ten-minute run limit.",
  },
} as const;

export class Chat extends AIChatAgent<Env, CodexState> {
  initialState: CodexState = {};
  private runFinished?: Promise<void>;

  protected sandbox() {
    return getSandbox(this.env.Sandbox, this.name, { sleepAfter: "2m" });
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
      this.resetTurnState();
      return new Response(null, { status: 204 });
    }
    return super.onRequest(request);
  }

  // Leave the run active if stopping fails: another turn must not overlap it.
  private async finishRun(run: Run, status: Run["status"]) {
    const sandbox = this.sandbox();
    await stopCodex(sandbox, run);
    const stopReason = this.state.run?.stopReason;
    if (stopReason) status = stopOutcomes[stopReason].status;
    try {
      // A lost container must not overwrite the last checkpoint with an empty one.
      if ((await sandbox.exists("/tmp/codex-ready")).exists) {
        const threadId = await sandboxThread(sandbox, run, this.state.threadId);
        // Preserve native context in the warm container even if the backup fails.
        this.setState({ ...this.state, threadId });
        const backup = await checkpointCodex(sandbox);
        this.setState({
          ...this.state,
          threadId,
          checkpoint: { backup, threadId },
        });
      }
    } catch (error) {
      status = "failed";
      throw error;
    } finally {
      await sandbox.setKeepAlive(false);
      this.setState({ ...this.state, run: { ...this.state.run!, status } });
    }
  }

  private errorMessage(error: unknown) {
    const message = error instanceof Error ? error.message : "Codex failed.";
    return this.env.CODEX_API_KEY
      ? message.split(this.env.CODEX_API_KEY).join("[REDACTED]")
      : message;
  }

  private interruption?: Promise<void>;

  private async interruptRun(reason: NonNullable<Run["stopReason"]>) {
    const run = this.state.run;
    if (run?.status !== "running") return;
    this.setState({ ...this.state, run: { ...run, stopReason: reason } });
    // A stuck graceful stop must not prevent the durable deadline from cleaning up.
    if (reason === "deadline") await forceStopCodex(this.sandbox(), run);
    if (this.interruption) return this.interruption;
    this.interruption = (async () => {
      if (this.runFinished) {
        await stopCodex(this.sandbox(), run);
        // The live coordinator also checks stopReason after the start RPC returns.
        await this.runFinished;
        if (this.state.run?.status === "running")
          throw new Error("Cleanup is pending; another turn cannot start yet.");
        return;
      }
      let checkpointError = "";
      try {
        await this.finishRun(run, stopOutcomes[reason].status);
      } catch (error) {
        if (this.state.run?.status === "running") throw error;
        checkpointError = ` Checkpoint failed: ${this.errorMessage(error)}`;
      }
      const outcome = stopOutcomes[this.state.run?.stopReason ?? reason];
      const text = outcome.message + checkpointError;
      const id = `codex-${run.id}`;
      await this.persistMessages([
        ...this.messages.filter((message) => message.id !== id),
        { id, role: "assistant", parts: [{ type: "text", text }] },
      ]);
    })();
    try {
      await this.interruption;
    } finally {
      this.interruption = undefined;
    }
  }

  // The durable deadline remains useful even if no browser or relay reconnects.
  async expireRun({ id }: { id: string }) {
    if (this.state.run?.id !== id || this.state.run.status !== "running")
      return;
    try {
      await this.interruptRun("deadline");
    } catch (error) {
      console.error("Codex cleanup will retry", this.errorMessage(error));
      await this.schedule(30, "expireRun", { id });
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
    if (this.state.run?.status === "running")
      throw new Error("The previous Codex run is still active.");
    if (this.state.run?.messageId === message.id)
      throw new Error(
        "This turn was already attempted. Send a new message to continue.",
      );

    const run: Run = {
      id: crypto.randomUUID(),
      messageId: message.id,
      startedAt: Date.now(),
      status: "running",
    };
    this.setState({ ...this.state, run });
    let resolveRun!: () => void;
    this.runFinished = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });

    return createUIMessageStreamResponse({
      stream: createUIMessageStream({
        onError: (error) => this.errorMessage(error),
        execute: async ({ writer }) => {
          const sandbox = this.sandbox();
          let deadlineId: string | undefined;
          let failure: unknown;
          let status: Run["status"] = "completed";
          writer.write({ type: "start", messageId: `codex-${run.id}` });
          try {
            try {
              // Persist cleanup before enabling keep-alive or starting paid work.
              const deadline = await this.schedule(
                new Date(run.startedAt + MAX_RUN_MS + 60_000),
                "expireRun",
                { id: run.id },
              );
              deadlineId = deadline.id;
              await sandbox.setKeepAlive(true);
              const threadId = await prepareSandbox(sandbox, this.state);
              this.setState({ ...this.state, threadId });
              if (!this.state.run?.stopReason) {
                await startCodex(sandbox, run, {
                  prompt,
                  threadId,
                  model: this.env.CODEX_MODEL,
                  apiKey: this.env.CODEX_API_KEY,
                });
                if (this.state.run?.stopReason) await stopCodex(sandbox, run);
                const result = await observeCodex(
                  sandbox,
                  run,
                  (chunk) => writer.write(chunk),
                  options?.abortSignal,
                );
                status = result.status;
                if (result.error) failure = new Error(result.error);
              }
            } catch (error) {
              failure = error;
              status = "failed";
            }
            const reason = this.state.run?.stopReason;
            if (reason) {
              const outcome = stopOutcomes[reason];
              status = outcome.status;
              failure =
                reason === "cancelled" ? undefined : new Error(outcome.message);
            }
            try {
              await this.finishRun(run, status);
              if (deadlineId) await this.cancelSchedule(deadlineId);
            } catch (error) {
              failure = error;
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
