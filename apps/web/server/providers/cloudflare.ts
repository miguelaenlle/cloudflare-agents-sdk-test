import { once } from "node:events";
import { WebSocketChatTransport } from "agents/chat/transport";
import { validateUIMessages } from "ai";
import { z } from "zod";
import {
  CONVERSATION_ID,
  type ChatConnection,
  type ChatProvider,
} from "@playground/chat-contract";

const CONNECTION_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const resumeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cf_agent_stream_resuming"), id: z.string() }),
  z.object({
    type: z.literal("cf_agent_stream_resume_none"),
    probeId: z.string().optional(),
  }),
  z.object({ type: z.literal("cf_agent_stream_pending") }),
]);

export function createCloudflareProvider(workerUrl: URL): ChatProvider {
  const agentUrl = new URL(`/agents/chat/${CONVERSATION_ID}`, workerUrl);

  async function request(
    path: string,
    method: string,
    signal: AbortSignal,
    body?: unknown,
  ) {
    const response = await fetch(`${agentUrl}/${path}`, {
      method,
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]),
    });
    if (!response.ok) {
      throw new Error(
        (await response.json().catch(() => null))?.error ??
          `Cloudflare ${method} ${path} failed (${response.status}).`,
      );
    }
    return response;
  }

  return {
    async getHistory(signal) {
      const response = await request("get-messages", "GET", signal);
      const messages: unknown = await response.json();
      // An empty history is valid, although the SDK validates nonempty chat requests.
      if (Array.isArray(messages) && messages.length === 0) return [];
      return validateUIMessages({ messages });
    },
    async steer(input, signal) {
      await request("steer", "POST", signal, input);
    },
    async cancel(signal) {
      await request("cancel", "POST", signal);
    },
    connect(signal) {
      return connectToAgent(agentUrl, signal);
    },
  };
}

async function connectToAgent(
  agentUrl: URL,
  clientSignal: AbortSignal,
): Promise<ChatConnection> {
  clientSignal.throwIfAborted();
  const socketUrl = new URL(agentUrl);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";

  const socket = new WebSocket(socketUrl);
  const lifetime = new AbortController();
  const listeners = new AbortController();
  const transport = new WebSocketChatTransport({
    agent: socket,
    cancelOnClientAbort: false,
  });
  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    transport.resetResumeState();
    lifetime.abort();
    listeners.abort();
    socket.close();
  }

  function handleDisconnect() {
    lifetime.abort(new Error("Cloudflare connection closed."));
    transport.cancelPendingResume();
  }

  function handleMessage(event: MessageEvent) {
    // The SDK reads chat chunks directly. Only resume control events need forwarding.
    try {
      const parsed = resumeEventSchema.safeParse(
        JSON.parse(String(event.data)),
      );
      if (!parsed.success) return;
      const message = parsed.data;
      switch (message.type) {
        case "cf_agent_stream_resuming":
          transport.handleStreamResuming(message);
          break;
        case "cf_agent_stream_resume_none":
          transport.handleStreamResumeNone(message);
          break;
        case "cf_agent_stream_pending":
          transport.handleStreamPending();
          break;
      }
    } catch (error) {
      lifetime.abort(
        new Error("Invalid Cloudflare protocol message.", { cause: error }),
      );
      transport.cancelPendingResume();
    }
  }

  const listenerOptions = { signal: listeners.signal };
  clientSignal.addEventListener("abort", close, listenerOptions);
  socket.addEventListener("close", handleDisconnect, listenerOptions);
  socket.addEventListener("error", handleDisconnect, listenerOptions);
  socket.addEventListener("message", handleMessage, listenerOptions);

  try {
    await once(socket, "open", {
      signal: AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
      ]),
    });
  } catch (error) {
    close();
    throw new Error("Could not connect to Cloudflare.", { cause: error });
  }

  return {
    close,
    async send(messages) {
      const stream = await transport.sendMessages({
        chatId: CONVERSATION_ID,
        messages,
        trigger: "submit-message",
        abortSignal: lifetime.signal,
      });
      // End the HTTP stream when its upstream socket disappears, so the UI can resume.
      return stream.pipeThrough(new TransformStream(), {
        signal: lifetime.signal,
      });
    },
    async resume() {
      const stream = await transport.reconnectToStream({
        chatId: CONVERSATION_ID,
      });
      lifetime.signal.throwIfAborted();
      return (
        stream?.pipeThrough(new TransformStream(), {
          signal: lifetime.signal,
        }) ?? null
      );
    },
  };
}
