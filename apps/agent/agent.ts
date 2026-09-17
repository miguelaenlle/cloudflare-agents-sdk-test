import { setTimeout as delay } from "node:timers/promises";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { routeAgentRequest } from "agents";
import { convertToModelMessages, stepCountIs, streamText, tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

interface Env {
  AI: Ai;
  Chat: DurableObjectNamespace<Chat>;
  UI_ORIGIN: string;
}

export class Chat extends AIChatAgent<Env> {
  override async onRequest(request: Request) {
    if (
      request.method === "POST" &&
      new URL(request.url).pathname.endsWith("/cancel")
    ) {
      this.resetTurnState();
      return new Response(null, { status: 204 });
    }
    return super.onRequest(request);
  }

  override async onChatMessage(
    _onFinish: Parameters<AIChatAgent<Env>["onChatMessage"]>[0],
    options?: OnChatMessageOptions,
  ) {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system:
        "You are a concise, helpful assistant. When asked to run the one-minute task, call waitOneMinute once, then report its returned timestamps. Explain that this is a simulated slow task, not research or computation.",
      messages: await convertToModelMessages(this.messages),
      abortSignal: options?.abortSignal,
      stopWhen: stepCountIs(3),
      tools: {
        waitOneMinute: tool({
          description:
            "Simulate one minute of background work to test closing and reopening the chat.",
          inputSchema: z.object({}),
          execute: async (_input, { abortSignal }) => {
            const startedAt = new Date().toISOString();
            // The SDK keeps the turn alive without a browser; explicit Stop cancels this wait.
            await delay(60_000, undefined, { signal: abortSignal });
            return { startedAt, finishedAt: new Date().toISOString() };
          },
        }),
      },
    });
    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request, env) {
    // CORS covers history requests; WebSocket upgrades need an origin check too.
    const origin = request.headers.get("Origin");
    if (origin && origin !== env.UI_ORIGIN) {
      return new Response("Origin not allowed", { status: 403 });
    }
    return (
      (await routeAgentRequest(request, env, {
        cors: {
          "Access-Control-Allow-Origin": env.UI_ORIGIN,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          Vary: "Origin",
        },
      })) ?? new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
