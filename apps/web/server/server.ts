import express, { type ErrorRequestHandler, type Response } from "express";
import { pipeUIMessageStreamToResponse } from "ai";
import { z } from "zod";
import {
  ChatError,
  CANCEL_API,
  CHAT_API,
  sendRequestSchema,
  HISTORY_API,
  RESUME_API,
} from "@playground/chat-contract";
import { createCloudflareProvider } from "./providers/cloudflare.ts";

const config = z
  .object({
    AGENT_URL: z
      .url()
      .refine(
        (value) => ["http:", "https:"].includes(new URL(value).protocol),
        "Use an HTTP or HTTPS Worker URL.",
      ),
    PORT: z.coerce.number().int().min(1).max(65535).default(4316),
  })
  .parse(process.env);
const provider = createCloudflareProvider(new URL(config.AGENT_URL));
const app = express();
app.disable("x-powered-by");

function clientSignal(response: Response) {
  const controller = new AbortController();
  response.once("close", () => controller.abort());
  return controller.signal;
}

async function streamChat(response: Response) {
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

app.get("/api/chat/diagnostics", async (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json(await provider.getDiagnostics(clientSignal(response)));
});
app.get(HISTORY_API, async (_request, response) => {
  const messages = await provider.getHistory(clientSignal(response));
  response.setHeader("Cache-Control", "no-store");
  response.json(messages);
});

app.post(CANCEL_API, async (_request, response) => {
  await provider.cancel(clientSignal(response));
  response.status(204).end();
});

app.post(
  CHAT_API,
  express.json({ limit: 1_000_000 }),
  async (request, response) => {
    const input = sendRequestSchema.safeParse(request.body);
    if (!input.success) {
      response.status(400).send("Expected a message ID and nonempty text.");
      return;
    }
    await provider.send(input.data, clientSignal(response));
    response.status(204).end();
  },
);

app.get(RESUME_API, async (_request, response) => {
  await streamChat(response);
});

const handleError: ErrorRequestHandler = (error, _request, response, _next) => {
  if (response.destroyed) return;
  // A broken SSE stream signals reconnection; an error body would corrupt it.
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

app.listen(config.PORT, "127.0.0.1", () => {
  console.log(`Chat relay listening on http://127.0.0.1:${config.PORT}`);
});
