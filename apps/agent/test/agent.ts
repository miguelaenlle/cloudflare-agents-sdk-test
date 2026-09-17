import { Chat as ProductionChat } from "../agent.ts";
import worker from "../agent.ts";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { setTimeout as delay } from "node:timers/promises";

// Local-only fixture: exercise the real durable chat machinery without inference.
export class Chat extends ProductionChat {
  override async onChatMessage(
    ...args: Parameters<ProductionChat["onChatMessage"]>
  ) {
    const signal = args[1]?.abortSignal;
    const toolCallId = crypto.randomUUID();
    return createUIMessageStreamResponse({
      stream: createUIMessageStream({
        execute: async ({ writer }) => {
          writer.write({ type: "start", messageId: crypto.randomUUID() });
          writer.write({ type: "text-start", id: "text" });
          writer.write({ type: "text-delta", id: "text", delta: "Started. " });
          writer.write({
            type: "tool-input-available",
            toolCallId,
            toolName: "waitOneMinute",
            input: {},
          });
          try {
            await delay(8_000, undefined, { signal });
            writer.write({
              type: "tool-output-available",
              toolCallId,
              output: { completed: true },
            });
            writer.write({
              type: "text-delta",
              id: "text",
              delta: "Finished.",
            });
          } catch {
            writer.write({ type: "abort" });
          }
          writer.write({ type: "text-end", id: "text" });
          writer.write({ type: "finish" });
        },
      }),
    });
  }
}
export default worker;
