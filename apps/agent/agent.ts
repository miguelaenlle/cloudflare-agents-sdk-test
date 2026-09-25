import { AIChatAgent } from "@cloudflare/ai-chat";
import { getSandbox } from "@cloudflare/sandbox";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessageChunk,
} from "ai";
import {
  approvalOutcomeSchema,
  ChatError,
  type ApprovalDecision,
  sendRequestSchema,
  type SendRequest,
  type SandboxDiagnostics,
} from "@playground/chat-contract";
import { AppServer, AppServerError, within } from "./app-server.ts";
import type { Sandbox } from "./sandbox.ts";
import { openCodexTurn, type CodexTurn } from "./codex-turn.ts";
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
import { captureApproval, toolResult } from "./approval.ts";
import type { DynamicToolCallResponse, Turn } from "./protocol.ts";

export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  Chat: DurableObjectNamespace<Chat>;
  CODEX_MODEL?: string;
  RELAY_TOKEN?: string;
  LOCAL_DEV?: string;
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
  "User interaction deadline reached. Sandbox cleanup started; another turn must wait for confirmed destruction.";
const interruptedMessage =
  "Task interrupted. It was not automatically repeated. You can send another message to continue.";

export class Chat extends AIChatAgent<Env, CodexState> {
  initialState: CodexState = {};
  private active?: CodexTurn;
  private controlTail: Promise<unknown> = Promise.resolve();
  private chatTask?: Promise<void>;
  private acceptance?: { resolve(): void; reject(error: unknown): void };
  private turnInProgress = false;
  private recovery?: Promise<void>;
  private approvalResult?: (result: DynamicToolCallResponse) => void;

  protected get interactionTimeoutMs() {
    return USER_IDLE_MS;
  }
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
      new Date(Math.ceil((at + this.interactionTimeoutMs) / 1000) * 1000),
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
    if (request.method === "GET" && path.endsWith("/snapshot")) {
      await this.controlTail;
      return Response.json(
        {
          messages: this.messages,
          revision: this.state.revision ?? 0,
          blocked:
            !!this.state.approvalDelivery ||
            !!this.state.approvalPreparing ||
            this.state.approval?.status === "pending",
          approval: this.state.approval,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (request.method === "POST" && path.endsWith("/approval")) {
      const parsed = approvalOutcomeSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success)
        return Response.json(
          { error: "Invalid approval decision." },
          { status: 400 },
        );
      const operation = this.controlTail.then(() => this.decide(parsed.data));
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
    if (request.method === "GET" && path.endsWith("/diagnostics")) {
      const sandbox = this.state.sandbox;
      return Response.json(
        {
          state: sandbox?.phase ?? "absent",
          idleExpiresAt:
            sandbox?.phase === "waiting_for_user" &&
            sandbox.waitingSince !== undefined
              ? sandbox.waitingSince + SANDBOX_IDLE_MS
              : null,
          interactionExpiresAt: sandbox
            ? sandbox.lastUserInteractionAt + this.interactionTimeoutMs
            : null,
        } satisfies SandboxDiagnostics,
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (
      request.method !== "POST" ||
      (!path.endsWith("/cancel") && !path.endsWith("/message"))
    )
      return super.onRequest(request);
    let input: SendRequest | undefined;
    if (path.endsWith("/message")) {
      const parsed = sendRequestSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success)
        return Response.json(
          { error: "Expected a message ID and nonempty text." },
          { status: 400 },
        );
      input = parsed.data;
    }
    // Serialize short control operations, not whole agent turns. The DO decides start vs. steer.
    const operation = this.controlTail.then(() =>
      input ? this.send(input) : this.cancel(),
    );
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

  private async send(input: SendRequest, continuation = false) {
    if (this.messages.some((message) => message.id === input.id)) return;
    if (!continuation) {
      if (input.expectedRevision !== (this.state.revision ?? 0))
        throw new ChatError(
          409,
          "This conversation changed in another tab. Refresh history; your draft is preserved.",
        );
      if (
        this.state.approval?.status === "pending" ||
        this.state.approvalDelivery ||
        this.state.approvalPreparing
      )
        throw new ChatError(
          409,
          "Resolve the pending approval before sending another message.",
        );
    }
    // Reserve the revision before async submission: an uncertain acknowledgment must not accept another stale send.
    this.setState({ ...this.state, revision: (this.state.revision ?? 0) + 1 });
    const message = {
      id: input.id,
      role: "user" as const,
      parts: [{ type: "text" as const, text: input.text }],
    };
    const run = this.state.run;
    const active = this.active;
    if (active && !active.terminal && run?.threadId && run.turnId) {
      this.ensureUsable(run.sandboxId);
      let steered = false;
      try {
        await active.steer({
          threadId: run.threadId,
          expectedTurnId: run.turnId,
          clientUserMessageId: input.id,
          input: [{ type: "text", text: input.text, text_elements: [] }],
        });
        steered = true;
      } catch (error) {
        // Only a rejected RPC plus a confirmed terminal turn allows start instead.
        // A timeout/disconnect can hide acceptance and must never resubmit the message.
        if (!(error instanceof AppServerError)) throw error;
        if (!active.terminal) {
          const { thread } = await active.client.request("thread/read", {
            threadId: run.threadId,
            includeTurns: true,
          });
          const turn = thread.turns.find((turn) => turn.id === run.turnId);
          if (!turn || turn.status === "inProgress") throw error;
        }
      }
      if (steered) {
        await this.persistMessages([...this.messages, message]);
        await this.interaction();
        return;
      }
    }
    // Finish transcript persistence before the next turn can own the stream.
    await this.chatTask;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const accepted = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.acceptance = { resolve, reject };
    const task = this.saveMessages((messages) => [...messages, message])
      .then((result) => {
        reject(
          new Error(result.error ?? "Turn ended before startup was confirmed."),
        );
      })
      .catch((error: unknown) => {
        reject(error);
      });
    this.chatTask = task;
    this.ctx.waitUntil(task);
    try {
      await within(
        accepted,
        25_000,
        "Message acceptance is unconfirmed. Check history before retrying.",
      );
    } finally {
      this.acceptance = undefined;
    }
  }

  private async decide(input: ApprovalDecision & { result: string }) {
    const receipt = this.state.approvalReceipts?.[input.id];
    if (receipt) {
      if (
        receipt.digest !== input.digest ||
        receipt.approved !== input.approved
      )
        throw new ChatError(409, "A different decision was already recorded.");
      return;
    }
    const approval = this.state.approval;
    if (
      !approval ||
      approval.id !== input.id ||
      approval.digest !== input.digest
    )
      throw new ChatError(409, "This approval is no longer current.");
    if (approval.status !== "pending") {
      if ((approval.status === "approved") !== input.approved)
        throw new ChatError(409, "A different decision was already recorded.");
      if (!this.state.approvalDelivery) return;
    } else {
      if (input.expectedRevision !== (this.state.revision ?? 0))
        throw new ChatError(
          409,
          "Conversation changed. Refresh before deciding.",
        );
      this.setState({
        ...this.state,
        revision: (this.state.revision ?? 0) + 1,
        approvalDelivery: approval.id,
        approval: {
          ...approval,
          status: input.approved ? "approved" : "denied",
          result: input.result,
        },
      });
    }
    if (
      this.state.sandbox &&
      ["suspending", "destroying", "cleanup_failed"].includes(
        this.state.sandbox.phase,
      )
    )
      throw new ChatError(
        409,
        "Sandbox cleanup is pending. Retry result delivery after cleanup.",
      );
    const result = this.state.approval!.result!;
    if (this.approvalResult && this.active && !this.active.terminal) {
      this.setState({
        ...this.state,
        sandbox: {
          ...this.state.sandbox!,
          phase: "waiting_for_agent",
          waitingSince: undefined,
        },
      });
      await this.interaction();
      this.approvalResult(toolResult(result));
      this.approvalResult = undefined;
      this.setState({
        ...this.state,
        approvalDelivery: undefined,
        approvalReceipts: {
          ...this.state.approvalReceipts,
          [input.id]: { digest: input.digest, approved: input.approved },
        },
      });
      return;
    }
    // A stopped app-server cannot receive an old RPC response. Resume its thread with the durable outcome instead.
    await this.send(
      {
        id: approval.id,
        text: `push_sync result for operation ${approval.id}: ${result}`,
        expectedRevision: this.state.revision ?? 0,
      },
      true,
    );
    this.setState({
      ...this.state,
      approvalDelivery: undefined,
      approvalReceipts: {
        ...this.state.approvalReceipts,
        [input.id]: { digest: input.digest, approved: input.approved },
      },
    });
  }

  private async requestApproval(args: unknown) {
    if (
      this.state.approval?.status === "pending" ||
      this.state.approvalPreparing
    )
      throw new Error("An approval is already pending.");
    const run = this.state.run!;
    this.setState({ ...this.state, approvalPreparing: true });
    let approval;
    try {
      approval = await captureApproval(this.sandbox(run.sandboxId), args);
    } finally {
      this.setState({ ...this.state, approvalPreparing: false });
    }
    this.ensureUsable(run.sandboxId);
    if (this.state.run?.id !== run.id || !this.active || this.active.terminal)
      throw new Error("Approval turn is no longer active.");
    const result = new Promise<DynamicToolCallResponse>((resolve) => {
      this.approvalResult = resolve;
    });
    this.setState({
      ...this.state,
      approval,
      revision: (this.state.revision ?? 0) + 1,
    });
    // The turn is blocked on a native tool response, so the same idle policy applies as waiting for a user prompt.
    await this.finishRun(run, "running");
    return result;
  }

  private async cancel() {
    const run = this.state.run;
    if (run?.status !== "running") return;
    this.ensureUsable(run.sandboxId);
    const active = this.active;
    if (active && run.threadId && run.turnId) {
      await active.interrupt(run.turnId);
      await this.interaction();
      await within(
        active.completed,
        5_000,
        "Stop is unconfirmed. Another turn remains blocked.",
      );
    } else if (this.turnInProgress) {
      throw new Error("Codex is still starting. Try Stop again shortly.");
    } else {
      await this.reconcile();
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
    const backup = await checkpointCodex(
      sandbox,
      this.env.LOCAL_DEV === "true",
    );
    if (this.usable(id))
      this.setState({ ...this.state, checkpoint: { backup, threadId } });
  }

  private async finishRun(run: Run, status: Run["status"]) {
    if (!this.usable(run.sandboxId)) return;
    if (this.state.sandbox?.phase === "suspending") {
      this.setState({ ...this.state, run: { ...this.state.run!, status } });
      return;
    }
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
      { id: run.sandboxId, reason: "idle", waitingSince } satisfies Expiration,
    );
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
      this.now() < state.lastUserInteractionAt + this.interactionTimeoutMs
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
        if (
          this.state.approval?.status === "pending" &&
          this.state.run?.status === "running" &&
          !this.active
        )
          await this.reconcile();
        if (this.state.sandbox?.id !== id) return;
        if (
          this.active &&
          this.state.run?.turnId &&
          this.state.approval?.status === "pending"
        ) {
          const active = this.active;
          const turnId = this.state.run.turnId;
          this.approvalResult?.(
            toolResult(
              "Approval remains pending. Pause now; the decision will be delivered after resumption.",
            ),
          );
          this.approvalResult = undefined;
          await within(
            active.interrupt(turnId).then(() => active.completed),
            5000,
            "Could not stop pending approval turn.",
          );
          await this.chatTask;
        }
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
          if (run?.status === "running") {
            if (!active || !run.threadId || !run.turnId)
              throw new Error(
                "Native execution is unconfirmed; skip final backup.",
              );
            await within(
              active.interrupt(run.turnId).then(() => active.completed),
              5_000,
              "Deadline Stop timed out.",
            );
          }
          const backup = await within(
            checkpointCodex(this.sandbox(id), this.env.LOCAL_DEV === "true"),
            10_000,
            "Deadline checkpoint timed out.",
          );
          if (this.state.sandbox?.id === id)
            this.setState({
              ...this.state,
              checkpoint: { backup, threadId: this.state.threadId },
            });
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
    const acceptance = this.acceptance;
    const message = this.messages.findLast(
      (message) => message.role === "user",
    );
    const prompt = message?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (!message || !prompt) throw new Error("Send a text prompt to Codex.");
    if (this.turnInProgress)
      throw new Error("The previous Codex run is still active.");
    if (this.state.run?.messageId === message.id)
      throw new Error("This prompt was already attempted. Send a new message.");
    const old = this.state.sandbox;
    if (
      old &&
      (old.phase === "cleanup_failed" ||
        this.now() >= old.lastUserInteractionAt + this.interactionTimeoutMs)
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
          let client: AppServer | undefined;
          let execution: CodexTurn | undefined;
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
              {
                assertCurrent: () => this.ensureUsable(sandbox.id),
              },
            );
            client = connected.client;
            this.ensureUsable(sandbox.id);
            execution = await openCodexTurn(client, {
              threadId: connected.threadId,
              model: this.env.CODEX_MODEL,
              runId: run.id,
              write,
              onPushSync: (params) => {
                if (
                  params.tool !== "push_sync" ||
                  params.threadId !== this.state.threadId ||
                  params.turnId !== this.state.run?.turnId
                )
                  throw new Error("Unknown tool request.");
                return Promise.race([
                  this.requestApproval(params.arguments),
                  client!.disconnected,
                ]);
              },
              onTurnStarted: (turnId) =>
                this.setRun({ ...this.state.run!, turnId }),
            });
            this.ensureUsable(sandbox.id);
            this.active = execution;
            this.setState({
              ...this.state,
              threadId: execution.threadId,
              run: { ...run, threadId: execution.threadId, submitted: true },
              sandbox: { ...this.state.sandbox!, phase: "waiting_for_agent" },
            });
            const started = await execution.start(prompt, message.id);
            this.setRun({ ...this.state.run!, turnId: started.id });
            acceptance?.resolve();
            const turn = await execution.completed;
            terminal = true;
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
            acceptance?.reject(error);
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
            await execution?.close();
            client?.close();
            this.active = undefined;
            this.approvalResult?.(
              toolResult(
                "Turn ended. Approval decision will be delivered on continuation.",
              ),
            );
            this.approvalResult = undefined;
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
