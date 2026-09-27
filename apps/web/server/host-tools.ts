import { z } from "zod";
import {
  hostToolCallSchema,
  hostToolResultSchema,
} from "@playground/chat-contract";

/** Host behavior lives in the relay; the DO only routes calls and correlates results. */
const tools: Record<string, (input: unknown) => unknown | Promise<unknown>> = {
  host_echo(input) {
    const { text } = z.object({ text: z.string().max(4096) }).parse(input);
    return { text, executedBy: "pl-relay" };
  },
};

export async function executeHostTool(message: unknown) {
  const call = hostToolCallSchema.parse(message);
  let result: z.infer<typeof hostToolResultSchema>["result"];
  try {
    if (!Object.hasOwn(tools, call.name)) throw new Error("Unknown host tool");
    console.log(`Executing host tool ${call.name} (${call.id})`);
    result = { ok: true, output: await tools[call.name]!(call.input) };
  } catch {
    // Do not send backend exception text or credentials into model context.
    result = { ok: false, error: "Host tool failed or its input was invalid." };
  }
  return { type: "host-tool-result" as const, id: call.id, result };
}

/** Durable preparation is supplied by PL; transport remains independent of its database and approval schemas. */
export async function dispatchHostTool(
  message: unknown,
  prepare: (call: z.infer<typeof hostToolCallSchema>) => Promise<void>,
) {
  const call = hostToolCallSchema.parse(message);
  if (call.sequence === undefined) return executeHostTool(call);
  await prepare(call);
  return { type: "host-tool-prepared", id: call.id };
}
