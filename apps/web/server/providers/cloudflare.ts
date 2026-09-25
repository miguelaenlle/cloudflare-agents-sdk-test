import WebSocket from "ws";
import { once } from "node:events";
import { WebSocketChatTransport } from "agents/chat/transport";
import { validateUIMessages } from "ai";
import { z } from "zod";
import {
  CONVERSATION_ID,
  ChatError,
  sandboxDiagnosticsSchema,
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

export function createCloudflareProvider(
  workerUrl: URL,
  id = CONVERSATION_ID,
): ChatProvider {
  const agentUrl = new URL(`/agents/chat/${encodeURIComponent(id)}`, workerUrl);

  async function request(
    path: string,
    method: string,
    signal: AbortSignal,
    body?: unknown,
  ) {
    const response = await fetch(`${agentUrl}/${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(process.env.RELAY_TOKEN
          ? { Authorization: `Bearer ${process.env.RELAY_TOKEN}` }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]),
    });
    if (!response.ok) {
      throw new ChatError(
        response.status,
        (await response.json().catch(() => null))?.error ??
          `Cloudflare ${method} ${path} failed (${response.status}).`,
      );
    }
    return response;
  }

  return {
    async getDiagnostics(signal) {
      const response = await request("diagnostics", "GET", signal);
      return sandboxDiagnosticsSchema.parse(await response.json());
    },
    async getHistory(signal) {
      const response = await request("get-messages", "GET", signal);
      const messages: unknown = await response.json();
      // An empty history is valid, although the SDK validates nonempty chat requests.
      if (Array.isArray(messages) && messages.length === 0) return [];
      return validateUIMessages({ messages });
    },
    async send(input, signal) {
      await request("message", "POST", signal, input);
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

  const socket = new WebSocket(socketUrl, {
    headers: process.env.RELAY_TOKEN
      ? { Authorization: `Bearer ${process.env.RELAY_TOKEN}` }
      : {},
  });
  const lifetime = new AbortController();
  const listeners = new AbortController();
  const events = new EventTarget();
  socket.on("message", (data) =>
    events.dispatchEvent(new MessageEvent("message", { data: String(data) })),
  );
  const transport = new WebSocketChatTransport({
    agent: {
      send: (data) => socket.send(data),
      addEventListener: (type, listener, options) =>
        events.addEventListener(type, listener as EventListener, options),
      removeEventListener: (type, listener) =>
        events.removeEventListener(type, listener as EventListener),
    },
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
  socket.on("close", handleDisconnect);
  socket.on("error", handleDisconnect);
  events.addEventListener(
    "message",
    (event) => handleMessage(event as MessageEvent),
    listenerOptions,
  );

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
