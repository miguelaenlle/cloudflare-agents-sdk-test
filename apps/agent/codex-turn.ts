import type { UIMessageChunk } from "ai";
import type { AppServer } from "./app-server.ts";
import { CodexEvents } from "./codex-events.ts";
import type { Turn, TurnSteerParams } from "./protocol.ts";

export type CodexTurn = Awaited<ReturnType<typeof openCodexTurn>>;

// Owns native protocol and event translation; the Chat DO owns durable state and cleanup.
export async function openCodexTurn(
  client: AppServer,
  {
    threadId,
    model,
    runId,
    write,
    onTurnStarted,
  }: {
    threadId?: string;
    model?: string;
    runId: string;
    write: (chunk: UIMessageChunk) => void;
    onTurnStarted: (turnId: string) => void;
  },
) {
  const options = {
    cwd: "/workspace/repo",
    approvalPolicy: "never" as const,
    sandbox: "workspace-write" as const,
    model,
  };
  const { thread } = threadId
    ? await client.request("thread/resume", { ...options, threadId })
    : await client.request("thread/start", options);
  if (thread.turns.some((turn) => turn.status === "inProgress"))
    throw new Error("Native thread still has an active turn.");

  const events = new CodexEvents(write, runId);
  const controls = new Set<Promise<unknown>>();
  async function control<T>(request: Promise<T>): Promise<T> {
    controls.add(request);
    try {
      return await request;
    } finally {
      controls.delete(request);
    }
  }
  let turnId: string | undefined;
  let resolve!: (turn: Turn) => void;
  const result = new Promise<Turn>((r) => {
    resolve = r;
  });
  const completed = Promise.race([result, client.disconnected]);
  // A disconnect can arrive before start() returns and its caller begins awaiting completion.
  void completed.catch(() => {});
  const execution = {
    client,
    threadId: thread.id,
    terminal: false,
    completed,
    async start(prompt: string, messageId: string) {
      const { turn } = await client.request("turn/start", {
        threadId: thread.id,
        clientUserMessageId: messageId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      });
      turnId = turn.id;
      return turn;
    },
    steer(input: TurnSteerParams) {
      return control(client.request("turn/steer", input));
    },
    interrupt(turnId: string) {
      return control(
        client.request("turn/interrupt", { threadId: thread.id, turnId }),
      );
    },
    async close() {
      // A terminal notification can precede the acknowledgment of Stop or steering.
      await Promise.allSettled(controls);
      unsubscribe();
      events.finish();
    },
  };
  const unsubscribe = client.subscribe((event) => {
    if (event.params.threadId !== thread.id) return;
    if (event.method === "turn/started") {
      turnId = event.params.turn.id;
      onTurnStarted(turnId);
    } else if (event.method === "turn/completed") {
      if (!turnId || event.params.turn.id === turnId) {
        execution.terminal = true;
        for (const item of event.params.turn.items) events.item(item);
        resolve(event.params.turn);
      }
    } else if (event.params.turnId === turnId) events.accept(event);
  });
  return execution;
}
