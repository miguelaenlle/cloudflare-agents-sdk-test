import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  pipeUIMessageStreamToResponse,
  validateUIMessages,
  type UIMessage,
} from "ai";
import { z } from "zod";
import {
  CANCEL_API,
  CHAT_API,
  sendRequestSchema,
  HISTORY_API,
  RESUME_API,
} from "@playground/chat-contract";
import { createCloudflareProvider } from "./providers/cloudflare.ts";

const MAX_BODY_BYTES = 1_000_000;
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

class RequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readMessages(request: IncomingMessage): Promise<UIMessage[]> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES)
      throw new RequestError(413, "Chat request is too large.");
    chunks.push(chunk);
  }

  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const input = sendRequestSchema.parse(body);
    return await validateUIMessages({ messages: input.messages });
  } catch {
    throw new RequestError(
      400,
      "Expected a valid playground chat request with UI messages.",
    );
  }
}

async function streamChat(
  response: ServerResponse,
  signal: AbortSignal,
  messages?: UIMessage[],
) {
  const connection = await provider.connect(signal);
  try {
    const stream = messages
      ? await connection.send(messages)
      : await connection.resume();
    if (!stream) {
      response.writeHead(204).end();
      return;
    }
    await pipeUIMessageStreamToResponse({ response, stream });
  } finally {
    connection.close();
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
) {
  const client = new AbortController();
  response.once("close", () => client.abort());
  const path = new URL(request.url ?? "/", "http://localhost").pathname;

  try {
    switch (`${request.method} ${path}`) {
      case `GET ${HISTORY_API}`:
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        response.end(JSON.stringify(await provider.getHistory(client.signal)));
        return;
      case `POST ${CANCEL_API}`:
        await provider.cancel(client.signal);
        response.writeHead(204).end();
        return;
      case `POST ${CHAT_API}`:
        await streamChat(response, client.signal, await readMessages(request));
        return;
      case `GET ${RESUME_API}`:
        await streamChat(response, client.signal);
        return;
      default:
        response.writeHead(404).end("Not found");
    }
  } catch (error) {
    if (client.signal.aborted) return;
    if (!(error instanceof RequestError))
      console.error("Chat request failed:", error);
    // Once SSE starts, a broken connection signals retry; plain text would corrupt the stream.
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const status = error instanceof RequestError ? error.status : 502;
    const message =
      error instanceof RequestError
        ? error.message
        : "Agent unavailable. Check the backend terminal and reconnect.";
    response.writeHead(status, { "Content-Type": "text/plain" }).end(message);
  }
}

createServer(handleRequest).listen(config.PORT, "127.0.0.1", () => {
  console.log(`Chat relay listening on http://127.0.0.1:${config.PORT}`);
});
