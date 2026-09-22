import type { UIMessage, UIMessageChunk } from "ai";
import { z } from "zod";

export const CONVERSATION_ID = "playground";
export const CHAT_API = "/api/chat";
export const HISTORY_API = `${CHAT_API}/history`;
export const RESUME_API = `${CHAT_API}/${CONVERSATION_ID}/stream`;
export const STEER_API = `${CHAT_API}/steer`;
export const steerRequestSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  text: z.string().trim().min(1).max(100_000),
});
export type SteerRequest = z.infer<typeof steerRequestSchema>;

export const CANCEL_API = `${CHAT_API}/cancel`;

export const sendRequestSchema = z.object({
  id: z.literal(CONVERSATION_ID),
  messages: z.array(z.unknown()),
});

export interface ChatConnection {
  send(messages: UIMessage[]): Promise<ReadableStream<UIMessageChunk>>;
  resume(): Promise<ReadableStream<UIMessageChunk> | null>;
  // Detach the subscriber; cancelling the agent is a separate operation.
  close(): void;
}

export interface ChatProvider {
  getHistory(signal: AbortSignal): Promise<UIMessage[]>;
  steer(input: SteerRequest, signal: AbortSignal): Promise<void>;
  cancel(signal: AbortSignal): Promise<void>;
  connect(signal: AbortSignal): Promise<ChatConnection>;
}
