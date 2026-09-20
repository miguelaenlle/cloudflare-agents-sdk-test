import type { UIMessageChunk } from "ai";
import { z } from "zod";

const eventSchema = z.object({
  type: z.string(),
  item: z
    .object({
      id: z.string(),
      type: z.string(),
      text: z.string().optional(),
      command: z.string().optional(),
      aggregated_output: z.string().optional(),
      exit_code: z.number().nullable().optional(),
      changes: z
        .array(z.object({ path: z.string(), kind: z.string() }))
        .optional(),
    })
    .optional(),
});

// Codex emits complete JSONL items, not the AI SDK's message stream protocol.
export class CodexEvents {
  // Only complete lines are emitted; a killed runner may leave a partial final write.
  private pending = "";
  private seen = new Set<string>();
  private toolInputs = new Set<string>();

  private write: (chunk: UIMessageChunk) => void;
  private namespace: string;
  private pendingTools = new Set<string>();

  constructor(write: (chunk: UIMessageChunk) => void, namespace = "codex") {
    this.write = write;
    this.namespace = namespace;
  }

  failTools(errorText: string) {
    for (const toolCallId of this.pendingTools) {
      this.write({ type: "tool-output-error", toolCallId, errorText });
    }
    this.pendingTools.clear();
  }

  push(chunk: string) {
    this.pending += chunk;
    const lines = this.pending.split("\n");
    this.pending = lines.pop()!;
    for (const line of lines) {
      if (line.trim()) this.accept(JSON.parse(line));
    }
  }

  private accept(value: unknown) {
    const event = eventSchema.parse(value);
    const item = event.item;
    if (!item || !["item.started", "item.completed"].includes(event.type))
      return;
    const id = `${this.namespace}:${item.id}`;
    const key = `${event.type}:${id}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);

    if (item.type === "agent_message" && event.type === "item.completed") {
      this.write({ type: "text-start", id });
      this.write({ type: "text-delta", id, delta: item.text ?? "" });
      this.write({ type: "text-end", id });
    }
    if (item.type === "command_execution" || item.type === "file_change") {
      if (!this.toolInputs.has(id)) {
        this.toolInputs.add(id);
        this.pendingTools.add(id);
        this.write({
          type: "tool-input-available",
          toolCallId: id,
          toolName: item.type,
          dynamic: true,
          input:
            item.type === "command_execution"
              ? { command: item.command }
              : { changes: item.changes },
        });
      }
      if (event.type === "item.completed") {
        this.pendingTools.delete(id);
        this.write({
          type: "tool-output-available",
          toolCallId: id,
          output:
            item.type === "command_execution"
              ? { output: item.aggregated_output, exitCode: item.exit_code }
              : { changes: item.changes },
        });
      }
    }
    // Reasoning and unrelated protocol events are deliberately not UI messages.
  }
}
