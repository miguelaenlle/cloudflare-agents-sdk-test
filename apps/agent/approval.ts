import { z } from "zod";
import type { Approval } from "@playground/chat-contract";
import type { CodexSandbox } from "./codex.ts";
import type { DynamicToolSpec, DynamicToolCallResponse } from "./protocol.ts";

export const pushSyncTool: DynamicToolSpec = {
  type: "function",
  name: "push_sync",
  description:
    "Request human review of committed course changes. Supply the base commit and proposed commit. Wait for the result before further edits. PL publishes the exact approved patch to the configured repository; Course Sync is simulated. For an empty remote branch use 40 zeros as baseSha. After a REAL successful publication, git fetch and git pull before continuing.",
  inputSchema: {
    type: "object",
    properties: {
      baseSha: { type: "string" },
      proposedSha: { type: "string" },
    },
    required: ["baseSha", "proposedSha"],
    additionalProperties: false,
  },
};
const commits = z.object({
  baseSha: z.string().regex(/^[a-f0-9]{40}$/),
  proposedSha: z.string().regex(/^[a-f0-9]{40}$/),
});
export async function captureApproval(
  sandbox: CodexSandbox,
  args: unknown,
): Promise<Approval> {
  const { baseSha, proposedSha } = commits.parse(args);
  // SHA-only arguments and fixed flags: the agent never supplies shell syntax.
  const result = await sandbox.exec(
    `git -C /workspace/repo --no-pager diff --no-ext-diff --no-textconv --binary ${baseSha === "0".repeat(40) ? "4b825dc642cb6eb9a060e54bf8d69288fbee4904" : baseSha} ${proposedSha} --`,
    { timeout: 10000 },
  );
  if (!result.success || !result.stdout.trim())
    throw new Error("No reviewable committed changes.");
  if (new TextEncoder().encode(result.stdout).length > 262144)
    throw new Error("Diff exceeds 256 KiB.");
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          `${baseSha}\n${proposedSha}\n${result.stdout}`,
        ),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    id: crypto.randomUUID(),
    baseSha,
    proposedSha,
    diff: result.stdout,
    digest,
    status: "pending",
  };
}
export function toolResult(text: string): DynamicToolCallResponse {
  return { success: true, contentItems: [{ type: "inputText", text }] };
}
