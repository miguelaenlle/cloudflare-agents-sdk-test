import { z } from "zod";
import {
  proposalContent,
  approvalSchema,
  type Approval,
} from "@playground/chat-contract";
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
/** Capture an immutable proposal from untrusted sandbox files; the relay validates and publishes it separately. */
export async function captureApproval(
  sandbox: CodexSandbox,
  args: unknown,
): Promise<Approval> {
  const { baseSha, proposedSha } = commits.parse(args);
  const path = `/tmp/approval-${crypto.randomUUID()}.json`;
  let captured: { diff: string; files: Approval["files"] };
  // Read immutable blobs instead of the worktree; later edits cannot change the reviewed payload.
  const script = `import json, subprocess
base = "${baseSha === "0".repeat(40) ? "4b825dc642cb6eb9a060e54bf8d69288fbee4904" : baseSha}"
proposed = "${proposedSha}"
def git(*args):
    return subprocess.check_output(["git", "-C", "/workspace/repo", *args])
raw = git("diff", "--raw", "--no-renames", "-z", base, proposed).split(b"\\0")
files = []
for i in range(0, len(raw)-1, 2):
    meta = raw[i].decode().split()
    path = raw[i+1].decode()
    old, new = meta[0][1:], meta[1]
    content = None if new == "000000" else git("show", proposed + ":" + path).decode("utf-8")
    files.append(dict(path=path, content=content, mode=new, previousMode=old))
diff = git("diff", "--no-ext-diff", "--no-textconv", "--no-renames", base, proposed).decode("utf-8")
with open("${path}", "w") as f:
    json.dump(dict(diff=diff, files=files), f)
`;
  try {
    const result = await sandbox.exec(
      `python3 - <<'CAPTURE'\n${script}\nCAPTURE`,
      { timeout: 10000 },
    );
    if (!result.success)
      throw new Error("Could not capture committed text files.");
    captured = JSON.parse((await sandbox.readFile(path)).content);
  } finally {
    await sandbox.deleteFile(path);
  }
  const { diff, files } = captured;
  if (new TextEncoder().encode(JSON.stringify(files)).length > 262144)
    throw new Error("Captured files exceed 256 KiB.");
  if (!diff.trim()) throw new Error("No reviewable committed changes.");
  if (new TextEncoder().encode(diff).length > 262144)
    throw new Error("Diff exceeds 256 KiB.");
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(proposalContent(baseSha, proposedSha, files)),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return approvalSchema.parse({
    id: crypto.randomUUID(),
    baseSha,
    proposedSha,
    diff,
    files,
    digest,
    status: "pending",
  });
}
export function toolResult(text: string): DynamicToolCallResponse {
  return { success: true, contentItems: [{ type: "inputText", text }] };
}
