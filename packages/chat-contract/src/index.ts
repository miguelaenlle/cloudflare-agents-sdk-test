import type { UIMessage, UIMessageChunk } from "ai";
import { z } from "zod";

export const CONVERSATION_ID = "playground";
export const CHAT_API = "/api/chat";
export const HISTORY_API = `${CHAT_API}/history`;
export const RESUME_API = `${CHAT_API}/${CONVERSATION_ID}/stream`;
export const DIAGNOSTICS_API = `${CHAT_API}/diagnostics`;
export const CANCEL_API = `${CHAT_API}/cancel`;

export const sendRequestSchema = z.object({
  id: z.uuid(),
  expectedRevision: z.number().int().nonnegative().default(0),
  text: z.string().trim().min(1).max(100_000),
});
export type SendRequest = z.infer<typeof sendRequestSchema>;

export const sandboxDiagnosticsSchema = z.object({
  state: z.enum([
    "absent",
    "starting",
    "waiting_for_agent",
    "waiting_for_user",
    "suspending",
    "destroying",
    "cleanup_failed",
  ]),
  idleExpiresAt: z.number().nullable(),
  interactionExpiresAt: z.number().nullable(),
});
export type SandboxDiagnostics = z.infer<typeof sandboxDiagnosticsSchema>;

export interface ChatConnection {
  resume(): Promise<ReadableStream<UIMessageChunk> | null>;
  // Detach the subscriber; cancelling the agent is a separate operation.
  close(): void;
}

export interface ChatProvider {
  getSnapshot(signal: AbortSignal): Promise<ChatSnapshot>;
  getDiagnostics(signal: AbortSignal): Promise<SandboxDiagnostics>;
  getHistory(signal: AbortSignal): Promise<UIMessage[]>;
  send(input: SendRequest, signal: AbortSignal): Promise<void>;
  cancel(signal: AbortSignal): Promise<void>;
  connect(signal: AbortSignal): Promise<ChatConnection>;
}

export function conversationApi(id: string) {
  const chat = `/api/conversations/${encodeURIComponent(id)}/chat`;
  return {
    chat,
    history: `${chat}/history`,
    snapshot: `${chat}/snapshot`,
    diagnostics: `${chat}/diagnostics`,
    cancel: `${chat}/cancel`,
  };
}
export class ChatError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type ChatSnapshot = { messages: UIMessage[]; revision: number };
