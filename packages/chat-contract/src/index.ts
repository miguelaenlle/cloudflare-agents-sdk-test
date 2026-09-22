import type { UIMessage, UIMessageChunk } from "ai";
import { z } from "zod";

export const CONVERSATION_ID = "playground";
export const CHAT_API = "/api/chat";
export const HISTORY_API = `${CHAT_API}/history`;
export const RESUME_API = `${CHAT_API}/${CONVERSATION_ID}/stream`;
export const CANCEL_API = `${CHAT_API}/cancel`;

export const sendRequestSchema = z.object({
  id: z.uuid(),
  text: z.string().trim().min(1).max(100_000),
});
export type SendRequest = z.infer<typeof sendRequestSchema>;

export interface ChatConnection {
  resume(): Promise<ReadableStream<UIMessageChunk> | null>;
  // Detach the subscriber; cancelling the agent is a separate operation.
  close(): void;
}

export interface ChatProvider {
  getHistory(signal: AbortSignal): Promise<UIMessage[]>;
  send(input: SendRequest, signal: AbortSignal): Promise<void>;
  cancel(signal: AbortSignal): Promise<void>;
  connect(signal: AbortSignal): Promise<ChatConnection>;
}
