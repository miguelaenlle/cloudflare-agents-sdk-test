import { AIChatAgent } from "@cloudflare/ai-chat";
import { getSandbox } from "@cloudflare/sandbox";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import {
  ChatError,
  sendRequestSchema,
  type SendRequest,
} from "@playground/chat-contract";
import { within } from "./app-server.ts";
import type { Sandbox } from "./sandbox.ts";
import { connectCodex, type CodexSandbox, type CodexState } from "./codex.ts";
import { openCodexTurn, type CodexTurn } from "./codex-turn.ts";

export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  Chat: DurableObjectNamespace<Chat>;
  CODEX_MODEL?: string;
  RELAY_TOKEN?: string;
  LOCAL_DEV?: string;
  UI_ORIGIN: string;
}
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "Codex failed.";

export class Chat extends AIChatAgent<Env, CodexState> {
  initialState: CodexState = {};
  private active?: CodexTurn;
  private controlTail: Promise<unknown> = Promise.resolve();
  private chatTask?: Promise<void>;
  private acceptance?: { resolve(): void; reject(error: unknown): void };

  protected sandbox(id: string): CodexSandbox {
    return getSandbox(this.env.Sandbox, id, { sleepAfter: "10m" });
  }
  override async onRequest(request: Request) {
    const path = new URL(request.url).pathname;
    if (
      request.method !== "POST" ||
      (!path.endsWith("/message") && !path.endsWith("/cancel"))
    )
      return super.onRequest(request);
    let input: SendRequest | undefined;
    if (path.endsWith("/message")) {
      const parsed = sendRequestSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success)
        return Response.json(
          { error: "Expected a message ID and text." },
          { status: 400 },
        );
      input = parsed.data;
    }
    const operation = this.controlTail.then(async () => {
      if (input) return this.send(input);
      if (this.active && this.state.run?.turnId) {
        await this.active.interrupt(this.state.run.turnId);
        await within(this.active.completed, 5000, "Stop unconfirmed.");
      }
    });
    this.controlTail = operation.catch(() => {});
    try {
      await operation;
      return new Response(null, { status: 204 });
    } catch (error) {
      return Response.json(
        { error: messageOf(error) },
        { status: error instanceof ChatError ? error.status : 503 },
      );
    }
  }
  private async send(input: SendRequest) {
    if (this.messages.some((message) => message.id === input.id)) return;
    // No automatic replay after an uncertain submission or process loss.
    if (this.state.run?.status === "running")
      throw new ChatError(409, "A turn is running or requires recovery.");
    await this.chatTask;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const accepted = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.acceptance = { resolve, reject };
    const task = this.saveMessages((messages) => [
      ...messages,
      {
        id: input.id,
        role: "user",
        parts: [{ type: "text", text: input.text }],
      },
    ])
      .then((result) =>
        reject(new Error(result.error ?? "Startup was not confirmed.")),
      )
      .catch(reject);
    this.chatTask = task;
    this.ctx.waitUntil(task);
    try {
      await within(
        accepted,
        25000,
        "Message acceptance unconfirmed; check history before retrying.",
      );
    } finally {
      this.acceptance = undefined;
    }
  }
  protected override async onChatRecovery() {
    // Lifecycle reconciliation is introduced in the next PR; fail closed here.
    return { persist: false, continue: false };
  }
  override async onChatMessage() {
    const acceptance = this.acceptance;
    const message = this.messages.findLast(
      (message) => message.role === "user",
    );
    const prompt = message?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (!message || !prompt) throw new Error("Send a text prompt.");
    if (this.state.run?.status === "running")
      throw new Error("A turn is already active.");
    const run = {
      id: crypto.randomUUID(),
      messageId: message.id,
      sandboxId: this.name,
      status: "running" as const,
    };
    this.setState({ ...this.state, run });
    return createUIMessageStreamResponse({
      stream: createUIMessageStream({
        onError: messageOf,
        execute: async ({ writer }) => {
          let execution: CodexTurn | undefined;
          let connection: Awaited<ReturnType<typeof connectCodex>> | undefined;
          writer.write({ type: "start", messageId: `codex-${run.id}` });
          try {
            connection = await connectCodex(
              this.sandbox(run.sandboxId),
              this.state,
            );
            execution = await openCodexTurn(connection.client, {
              threadId: connection.threadId,
              model: this.env.CODEX_MODEL,
              runId: run.id,
              write: (chunk) => writer.write(chunk),
              onTurnStarted: (turnId) =>
                this.setState({
                  ...this.state,
                  run: { ...this.state.run!, turnId },
                }),
            });
            this.active = execution;
            this.setState({
              ...this.state,
              threadId: execution.threadId,
              run: { ...run, threadId: execution.threadId, submitted: true },
            });
            const started = await execution.start(prompt, message.id);
            this.setState({
              ...this.state,
              run: { ...this.state.run!, turnId: started.id },
            });
            acceptance?.resolve();
            const turn = await execution.completed;
            this.setState({
              ...this.state,
              run: {
                ...this.state.run!,
                status:
                  turn.status === "completed"
                    ? "completed"
                    : turn.status === "interrupted"
                      ? "cancelled"
                      : "failed",
              },
            });
            if (turn.status === "failed")
              throw new Error(turn.error?.message ?? "Codex failed.");
          } catch (error) {
            acceptance?.reject(error);
            if (!this.state.run?.submitted)
              this.setState({
                ...this.state,
                run: { ...run, status: "failed" },
              });
            writer.write({ type: "text-start", id: `${run.id}:error` });
            writer.write({
              type: "text-delta",
              id: `${run.id}:error`,
              delta: `Task failed: ${messageOf(error)}`,
            });
            writer.write({ type: "text-end", id: `${run.id}:error` });
          } finally {
            await execution?.close();
            connection?.client.close();
            this.active = undefined;
            writer.write({ type: "finish", finishReason: "stop" });
          }
        },
      }),
    });
  }
}
