import { z } from "zod";
import type {
  InitializeParams,
  ThreadStartParams,
  ThreadResumeParams,
  ThreadReadParams,
  TurnStartParams,
  TurnSteerParams,
  TurnInterruptParams,
  Thread,
  Turn,
  ItemStartedNotification,
  ItemCompletedNotification,
  AgentMessageDeltaNotification,
  TurnStartedNotification,
  TurnCompletedNotification,
} from "./protocol.ts";

export type Notification =
  | { method: "turn/started"; params: TurnStartedNotification }
  | { method: "turn/completed"; params: TurnCompletedNotification }
  | { method: "item/started"; params: ItemStartedNotification }
  | { method: "item/completed"; params: ItemCompletedNotification }
  | {
      method: "item/agentMessage/delta";
      params: AgentMessageDeltaNotification;
    };

type Methods = {
  initialize: [InitializeParams, unknown];
  "thread/start": [ThreadStartParams, { thread: Thread }];
  "thread/resume": [ThreadResumeParams, { thread: Thread }];
  "thread/read": [ThreadReadParams, { thread: Thread }];
  "turn/start": [TurnStartParams, { turn: Turn }];
  "turn/steer": [TurnSteerParams, { turnId: string }];
  "turn/interrupt": [TurnInterruptParams, unknown];
};
const envelope = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});
export interface Socket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
}

export function within<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Cloudflare supplies the socket. This client owns only Codex's JSON-RPC protocol.
export class AppServer {
  private socket: Socket;
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private subscribers = new Set<(event: Notification) => void>();
  private closed = false;
  readonly disconnected: Promise<never>;
  private rejectDisconnected!: (error: Error) => void;

  constructor(socket: Socket) {
    this.socket = socket;
    this.disconnected = new Promise((_, reject) => {
      this.rejectDisconnected = reject;
    });
    void this.disconnected.catch(() => {});
    socket.addEventListener("message", (event) => {
      try {
        const frame = envelope.parse(JSON.parse(String(event.data)));
        if (frame.method) {
          if (frame.id !== undefined) {
            // No approval or interactive-tool UI in this prototype. Never hang on an unsupported request.
            socket.send(
              JSON.stringify({
                id: frame.id,
                error: {
                  code: -32601,
                  message: "Client interaction is not supported",
                },
              }),
            );
          } else if (
            [
              "turn/started",
              "turn/completed",
              "item/started",
              "item/completed",
              "item/agentMessage/delta",
            ].includes(frame.method)
          ) {
            // Authenticated, version-pinned protocol; generated types describe the payload.
            const notification = frame as Notification;
            for (const subscriber of this.subscribers) subscriber(notification);
          }
        } else if (typeof frame.id === "number") {
          const pending = this.pending.get(frame.id);
          if (!pending) return;
          this.pending.delete(frame.id);
          if (frame.error) pending.reject(new Error(frame.error.message));
          else pending.resolve(frame.result);
        }
      } catch {
        this.fail(new Error("Invalid Codex app-server message."));
      }
    });
    socket.addEventListener("close", () =>
      this.fail(
        new Error("Codex connection closed; execution must be reconciled."),
      ),
    );
    socket.addEventListener("error", () =>
      this.fail(
        new Error("Codex connection failed; execution must be reconciled."),
      ),
    );
  }

  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.rejectDisconnected(error);
    this.socket.close(1000, "Client disconnected");
  }

  close() {
    this.fail(new Error("Codex client closed."));
  }

  async request<M extends keyof Methods>(
    method: M,
    params: Methods[M][0],
  ): Promise<Methods[M][1]> {
    if (this.closed) throw new Error("Codex connection is closed.");
    const id = ++this.nextId;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch {
        reject(new Error("Could not send Codex request."));
      }
    });
    try {
      // A timeout means an uncertain outcome: never retry a mutating request automatically.
      return (await within(
        response,
        15_000,
        `Codex ${method} acknowledgment timed out.`,
      )) as Methods[M][1];
    } finally {
      this.pending.delete(id);
    }
  }

  async initialize() {
    await this.request("initialize", {
      capabilities: null,
      clientInfo: {
        name: "pl_sandbox_prototype",
        title: "PL sandbox prototype",
        version: "1",
      },
    });
    this.socket.send(JSON.stringify({ method: "initialized" }));
  }

  subscribe(listener: (event: Notification) => void) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }
}
