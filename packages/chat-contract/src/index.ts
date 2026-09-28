import type { UIMessage, UIMessageChunk } from "ai";
import { z } from "zod";

// Prototype course configuration; PrairieLearn will resolve this from the authorized course.
export const GITHUB_REPOSITORY = "miguelaenlle/course-agent-push-sync-test";

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

export const cleanupDiagnosticsSchema = z.object({
  id: z.string(),
  stage: z.enum(["stop", "backup", "destroy"]),
  attempts: z.number().int().positive(),
  error: z.string().optional(),
  retryAt: z.number().nullable(),
});
export type CleanupDiagnostics = z.infer<typeof cleanupDiagnosticsSchema>;

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
  cleanup: cleanupDiagnosticsSchema.optional(),
  checkpointError: z.string().optional(),
  idleExpiresAt: z.number().nullable(),
  interactionExpiresAt: z.number().nullable(),
});
export type SandboxDiagnostics = z.infer<typeof sandboxDiagnosticsSchema>;

export interface ChatConnection {
  resume(): Promise<ReadableStream<UIMessageChunk> | null>;
  // Detach the subscriber; cancelling the agent is a separate operation.
  close(): void;
}

/** Backend provider boundary: controls/snapshots are JSON; observation yields standard AI SDK chunks. */
export interface ChatProvider {
  watch(
    signal: AbortSignal,
    changed: () => void,
    failed: () => void,
  ): Promise<() => void>;
  getSnapshot(signal: AbortSignal): Promise<ChatSnapshot>;
  getDiagnostics(signal: AbortSignal): Promise<SandboxDiagnostics>;
  retryCleanup(signal: AbortSignal): Promise<void>;
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
    events: `${chat}/events`,
    diagnostics: `${chat}/diagnostics`,
    cleanup: `${chat}/cleanup`,
    cancel: `${chat}/cancel`,
    approval: `${chat}/approval`,
  };
}
export type ChatSnapshot = {
  messages: UIMessage[];
  revision: number;
  blocked?: boolean;
  diagnostics?: SandboxDiagnostics;
};
export class ChatError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
