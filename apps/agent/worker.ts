import { ContainerProxy } from "@cloudflare/sandbox";
import { routeAgentRequest } from "agents";
import type { Env } from "./agent.ts";

export { Chat } from "./agent.ts";
export { Sandbox } from "./sandbox.ts";
export { ContainerProxy };

export default {
  async fetch(request, env) {
    // Only the chat is public; the Sandbox binding is an internal execution API.
    if (!new URL(request.url).pathname.startsWith("/agents/chat/")) {
      return new Response("Not found", { status: 404 });
    }
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
