import { createHash } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import {
  ChatError,
  proposalContent,
  GITHUB_REPOSITORY,
  type Approval,
} from "@playground/chat-contract";

export const EMPTY_BASE = "0".repeat(40);
export type Destination = { repository: string; branch: string };
export function destination(): Destination {
  return {
    repository: GITHUB_REPOSITORY,
    branch: process.env.PUSH_BRANCH ?? "main",
  };
}
export type Publication = {
  id: string;
  sequence: number;
  destination: Destination;
  approval: Approval;
  createdAt: string;
  candidate?: string;
};
export class PublishRejected extends Error {}

/** Publish immutable file contents using GitHub APIs. No checkout or Git executable runs in the relay. */
export class Publisher {
  private destination: Destination;
  private options: { token: string; fetch?: typeof fetch };
  constructor(
    destination: Destination,
    options: { token: string; fetch?: typeof fetch },
  ) {
    this.destination = destination;
    this.options = options;
  }

  private async request(path: string, body?: unknown) {
    const response = await (this.options.fetch ?? fetch)(
      `https://api.github.com${path}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      },
    ).catch(() => {
      throw new ChatError(
        502,
        "GitHub connection failed; publication outcome is unconfirmed. Retry completion.",
      );
    });
    // Do not forward provider response text: request errors can contain credentials or repository contents.
    if (!response.ok)
      throw new ChatError(
        502,
        `GitHub request failed (${response.status}). Check repository access and branch protection, then Retry.`,
      );
    return response.json();
  }

  /** Verify trusted base blobs and generate the visual diff from exactly the saved publication files. */
  async prepare(job: Publication): Promise<string> {
    const { approval } = job;
    const digest = createHash("sha256")
      .update(
        proposalContent(approval.baseSha, approval.proposedSha, approval.files),
      )
      .digest("hex");
    if (digest !== approval.digest)
      throw new PublishRejected("Proposal hash mismatch.");
    if (approval.baseSha === EMPTY_BASE)
      throw new PublishRejected(
        "Initialize the test repository with a commit on main before requesting publication.",
      );
    const root = `/repos/${this.destination.repository}`;
    const tree = (await this.request(
      `${root}/git/trees/${approval.baseSha}?recursive=1`,
    )) as {
      truncated: boolean;
      tree: { path: string; mode: string; sha: string }[];
    };
    if (tree.truncated)
      throw new PublishRejected("Repository tree exceeds prototype limits.");
    const seen = new Set<string>();
    let diff = "";
    let bytes = 0;
    for (const file of approval.files) {
      const components = file.path.split("/");
      if (
        seen.has(file.path) ||
        components.some(
          (p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git",
        ) ||
        components[0]?.toLowerCase() === ".github" ||
        /[\x00-\x1f\\]/.test(file.path)
      )
        throw new PublishRejected("Invalid or duplicate publication path.");
      seen.add(file.path);
      const previous = tree.tree.find((entry) => entry.path === file.path);
      // createCommitOnBranch has no file-mode parameter. Keep this prototype to ordinary text files.
      if (
        (previous?.mode ?? "000000") !== file.previousMode ||
        !["000000", "100644"].includes(file.previousMode) ||
        file.mode !== (file.content === null ? "000000" : "100644")
      )
        throw new PublishRejected(
          "Only ordinary text files are supported; executable files, symlinks, submodules and mode changes need a new proposal.",
        );
      if (!previous && file.content === null)
        throw new PublishRejected(
          "Deleted file is absent from the base commit.",
        );
      let before = "";
      if (previous) {
        const blob = (await this.request(
          `${root}/git/blobs/${previous.sha}`,
        )) as { content: string; encoding: string };
        if (blob.encoding !== "base64")
          throw new PublishRejected("Unsupported GitHub blob encoding.");
        before = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.from(blob.content, "base64"),
        );
      }
      const after = file.content ?? "";
      bytes += Buffer.byteLength(before) + Buffer.byteLength(after);
      if (bytes > 262144 || before.includes("\0") || after.includes("\0"))
        throw new PublishRejected(
          "Only text proposals up to 256 KiB are supported.",
        );
      diff += createTwoFilesPatch(
        previous ? `a/${file.path}` : "/dev/null",
        file.content === null ? "/dev/null" : `b/${file.path}`,
        before,
        after,
      );
    }
    if (!seen.size) throw new PublishRejected("Proposal contains no changes.");
    approval.diff = diff;
    return approval.digest;
  }

  /** Find an acknowledged-or-uncertain earlier commit in branch history before attempting another write. */
  private async published(job: Publication): Promise<string | undefined> {
    let cursor: string | null = null;
    let first = true;
    do {
      const result = (await this.request("/graphql", {
        query: `query($owner:String!,$name:String!,$ref:String!,$cursor:String){repository(owner:$owner,name:$name){ref(qualifiedName:$ref){target{... on Commit{history(first:100,after:$cursor){nodes{oid message} pageInfo{hasNextPage endCursor}}}}}}}`,
        variables: {
          owner: this.destination.repository.split("/")[0],
          name: this.destination.repository.split("/")[1],
          ref: `refs/heads/${this.destination.branch}`,
          cursor,
        },
      })) as {
        errors?: unknown;
        data?: {
          repository?: {
            ref?: {
              target: {
                history: {
                  nodes: { oid: string; message: string }[];
                  pageInfo: { hasNextPage: boolean; endCursor: string };
                };
              };
            };
          };
        };
      };
      const history = result.data?.repository?.ref?.target.history;
      if (result.errors || !history)
        throw new ChatError(
          502,
          "Could not inspect GitHub branch history. Initialize the branch and check access.",
        );
      for (const commit of history.nodes) {
        if (commit.message.trimEnd() === this.message(job)) return commit.oid;
        if (commit.oid === job.approval.baseSha) {
          if (first) return;
          throw new PublishRejected(
            "Main changed since this proposal. Fetch and prepare a new proposal.",
          );
        }
        first = false;
      }
      cursor = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
    } while (cursor);
    throw new PublishRejected(
      "The approved base is no longer in branch history. Prepare a new proposal.",
    );
  }
  private message(job: Publication) {
    return `Approved course-agent change ${job.id}\n\nProposal: ${job.approval.digest}`;
  }

  /** expectedHeadOid prevents overwriting concurrent changes. Unknown outcomes remain retryable. */
  async push(job: Publication): Promise<string> {
    if (!job.candidate) throw new Error("Proposal has not been validated.");
    const prior = await this.published(job);
    if (prior) return prior;
    const result = (await this.request("/graphql", {
      query:
        "mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid}}}",
      variables: {
        input: {
          branch: {
            repositoryNameWithOwner: job.destination.repository,
            branchName: job.destination.branch,
          },
          expectedHeadOid: job.approval.baseSha,
          message: {
            headline: `Approved course-agent change ${job.id}`,
            body: `Proposal: ${job.approval.digest}`,
          },
          fileChanges: {
            additions: job.approval.files
              .filter((f) => f.content !== null)
              .map((f) => ({
                path: f.path,
                contents: Buffer.from(f.content!).toString("base64"),
              })),
            deletions: job.approval.files
              .filter((f) => f.content === null)
              .map((f) => ({ path: f.path })),
          },
        },
      },
    })) as {
      errors?: unknown;
      data?: { createCommitOnBranch?: { commit: { oid: string } } };
    };
    if (result.errors || !result.data?.createCommitOnBranch)
      throw new ChatError(
        502,
        "GitHub did not confirm publication. Retry completion to reconcile the outcome.",
      );
    return result.data.createCommitOnBranch.commit.oid;
  }
}
