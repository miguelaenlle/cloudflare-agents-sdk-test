import type { UIMessageChunk } from "ai";
import type { Notification } from "./app-server.ts";
import type { ThreadItem } from "./protocol.ts";

export class CodexEvents {
  private text = new Map<string, string>();
  private ended = new Set<string>();
  private tools = new Set<string>();
  private completedTools = new Set<string>();
  private write: (chunk: UIMessageChunk) => void;
  private namespace: string;

  constructor(write: (chunk: UIMessageChunk) => void, namespace: string) {
    this.write = write;
    this.namespace = namespace;
  }

  accept(event: Notification) {
    if (event.method === "item/agentMessage/delta") {
      this.delta(event.params.itemId, event.params.delta);
    } else if (
      event.method === "item/started" ||
      event.method === "item/completed"
    ) {
      this.item(event.params.item, event.method === "item/completed");
    }
  }

  private delta(itemId: string, delta: string) {
    if (this.ended.has(itemId)) return;
    const id = `${this.namespace}:${itemId}`;
    if (!this.text.has(itemId)) this.write({ type: "text-start", id });
    this.text.set(itemId, (this.text.get(itemId) ?? "") + delta);
    if (delta) this.write({ type: "text-delta", id, delta });
  }

  item(item: ThreadItem, completed = true) {
    const id = `${this.namespace}:${item.id}`;
    if (item.type === "agentMessage" && completed && !this.ended.has(item.id)) {
      const existing = this.text.get(item.id) ?? "";
      this.delta(
        item.id,
        item.text.startsWith(existing) ? item.text.slice(existing.length) : "",
      );
      this.ended.add(item.id);
      this.write({ type: "text-end", id });
    }
    if (item.type !== "commandExecution" && item.type !== "fileChange") return;
    if (this.completedTools.has(id)) return;
    if (!this.tools.has(id)) {
      this.tools.add(id);
      this.write({
        type: "tool-input-available",
        toolCallId: id,
        dynamic: true,
        toolName:
          item.type === "commandExecution"
            ? "command_execution"
            : "file_change",
        input:
          item.type === "commandExecution"
            ? { command: item.command }
            : { changes: item.changes },
      });
    }
    if (completed) {
      this.tools.delete(id);
      this.completedTools.add(id);
      this.write({
        type: "tool-output-available",
        toolCallId: id,
        output:
          item.type === "commandExecution"
            ? { output: item.aggregatedOutput, exitCode: item.exitCode }
            : { changes: item.changes, status: item.status },
      });
    }
  }

  finish(errorText = "Codex stopped before reporting a result.") {
    for (const itemId of this.text.keys())
      if (!this.ended.has(itemId)) {
        this.ended.add(itemId);
        this.write({ type: "text-end", id: `${this.namespace}:${itemId}` });
      }
    for (const toolCallId of this.tools)
      this.write({ type: "tool-output-error", toolCallId, errorText });
    this.tools.clear();
  }
}
