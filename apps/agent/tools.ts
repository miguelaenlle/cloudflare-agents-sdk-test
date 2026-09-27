import { captureApproval, pushSyncTool } from "./approval.ts";
import type { CodexSandbox } from "./codex.ts";
import type { DynamicToolSpec, DynamicToolCallResponse } from "./protocol.ts";

/** Sandbox adapters prepare opaque payloads; the relay owns their product workflows. */
export type ToolAdapter = {
  definition: DynamicToolSpec;
  prepare(sandbox: CodexSandbox, args: unknown): Promise<unknown>;
};
export const tools: Record<string, ToolAdapter> = {
  push_sync: { definition: pushSyncTool, prepare: captureApproval },
};
export function getTool(name: string): ToolAdapter {
  if (!Object.hasOwn(tools, name)) throw new Error("Unknown tool request.");
  return tools[name];
}
export const toolDefinitions = Object.values(tools).map(
  (tool) => tool.definition,
);
export function toolResult(text: string): DynamicToolCallResponse {
  return { success: true, contentItems: [{ type: "inputText", text }] };
}
