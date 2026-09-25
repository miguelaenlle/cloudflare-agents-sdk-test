import express, { type ErrorRequestHandler, type Response } from "express";
import { pipeUIMessageStreamToResponse } from "ai";
import { z } from "zod";
import {
  ChatError,
  sendRequestSchema,
  type ChatProvider,
} from "@playground/chat-contract";
import { createCloudflareProvider } from "./providers/cloudflare.ts";
import {
  listConversations,
  createConversation,
  hasConversation,
} from "./conversations.ts";

const config = z
  .object({
    AGENT_URL: z.url(),
    PORT: z.coerce.number().int().min(1).max(65535).default(4316),
  })
  .parse(process.env);
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: 1_000_000 }));
// This localhost prototype has one trusted user. PrairieLearn must authorize each conversation here.
app.use((request, response, next) => {
  if (
    request.method !== "GET" &&
    request.headers.origin &&
    request.headers.origin !==
      (process.env.UI_ORIGIN ?? "http://localhost:4315")
  ) {
    response.status(403).send("Origin not allowed");
    return;
  }
  next();
});
function clientSignal(response: Response) {
  const controller = new AbortController();
  response.once("close", () => controller.abort());
  return controller.signal;
}
app.get("/api/conversations", (_request, response) =>
  response.json(listConversations()),
);
app.post("/api/conversations", (request, response) => {
  const parsed = z
    .object({ title: z.string().trim().min(1).max(100) })
    .safeParse(request.body);
  if (!parsed.success) {
    response.status(400).send("Expected a title.");
    return;
  }
  response.status(201).json(createConversation(parsed.data.title));
});
function routes(
  base: string,
  conversationId: (params: Record<string, string | string[]>) => string,
) {
  function provider(params: Record<string, string | string[]>) {
    const id = conversationId(params);
    if (!hasConversation(id))
      throw new ChatError(404, "Conversation not found.");
    return createCloudflareProvider(new URL(config.AGENT_URL), id);
  }
  app.get(`${base}/snapshot`, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(
      await provider(request.params).getSnapshot(clientSignal(response)),
    );
  });
  app.get(`${base}/history`, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(
      await provider(request.params).getHistory(clientSignal(response)),
    );
  });
  app.get(`${base}/diagnostics`, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(
      await provider(request.params).getDiagnostics(clientSignal(response)),
    );
  });
  app.post(base, async (request, response) => {
    const parsed = sendRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response
        .status(400)
        .send("Expected a message ID, revision and nonempty text.");
      return;
    }
    await provider(request.params).send(parsed.data, clientSignal(response));
    response.status(204).end();
  });
  app.post(`${base}/cancel`, async (request, response) => {
    await provider(request.params).cancel(clientSignal(response));
    response.status(204).end();
  });
  app.get(`${base}/:chatId/stream`, async (request, response) => {
    if (request.params.chatId !== conversationId(request.params))
      throw new ChatError(404, "Conversation not found.");
    await streamChat(provider(request.params), response);
  });
}
routes("/api/conversations/:conversationId/chat", (params) =>
  z.string().parse(params.conversationId),
);
routes("/api/chat", () => "playground");
async function streamChat(provider: ChatProvider, response: Response) {
  const connection = await provider.connect(clientSignal(response));
  try {
    const stream = await connection.resume();
    if (!stream) {
      response.status(204).end();
      return;
    }
    await pipeUIMessageStreamToResponse({ response, stream });
  } finally {
    connection.close();
  }
}
const handleError: ErrorRequestHandler = (error, _request, response, _next) => {
  if (response.destroyed) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (error instanceof ChatError) {
    response.status(error.status).send(error.message);
    return;
  }
  if (error.type === "entity.too.large") {
    response.status(413).send("Chat request is too large.");
    return;
  }
  if (error.type === "entity.parse.failed") {
    response.status(400).send("Expected valid JSON.");
    return;
  }
  console.error("Chat request failed:", error);
  response
    .status(502)
    .send("Agent unavailable. Check the backend terminal and reconnect.");
};
app.use(handleError);
app.listen(config.PORT, "127.0.0.1", () =>
  console.log(`Chat relay listening on http://127.0.0.1:${config.PORT}`),
);
