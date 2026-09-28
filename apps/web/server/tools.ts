import {
  approvalSchema,
  approvalDisplaySchema,
  type PendingTool,
  type ApprovalDisplay,
} from "@playground/chat-contract";
import type { UIMessage } from "ai";
import { destination, type Publication } from "./publish.ts";

/** PL-specific preparation stays outside generic pending-call transport. */
const tools: Record<string, { prepare(call: PendingTool): Publication }> = {
  push_sync: {
    prepare(call) {
      return {
        id: call.id,
        sequence: call.sequence,
        destination: destination(),
        approval: approvalSchema.parse({
          ...(call.args as object),
          id: call.id,
        }),
        createdAt: new Date().toISOString(),
      };
    },
  },
};
export function prepareTool(call: PendingTool): Publication {
  if (!Object.hasOwn(tools, call.name))
    throw new Error("Unregistered relay tool.");
  return tools[call.name]!.prepare(call);
}

/** Completed cards hydrate from history after their execution record has been replaced. */
export function historicalApprovals(messages: UIMessage[]): ApprovalDisplay[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (
        part.type !== "data-tool-display" ||
        !part.data ||
        typeof part.data !== "object" ||
        !("name" in part.data) ||
        part.data.name !== "push_sync" ||
        !("value" in part.data)
      )
        return [];
      return [approvalDisplaySchema.parse(part.data.value)];
    }),
  );
}
