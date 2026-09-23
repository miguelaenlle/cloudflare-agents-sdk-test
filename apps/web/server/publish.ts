import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Approval } from "@playground/chat-contract";

const exec = promisify(execFile);
export const EMPTY_BASE = "0".repeat(40);
export const TEST_REPOSITORY = "miguelaenlle/course-agent-push-sync-test";
export type Destination = { repository: string; branch: string };
export function destination(): Destination {
  const repository = process.env.PUSH_REPOSITORY ?? TEST_REPOSITORY;
  const branch = process.env.PUSH_BRANCH ?? "main";
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch)
  )
    throw new Error("Invalid publication destination.");
  return { repository, branch };
}
export type Publication = {
  id: string;
  destination: Destination;
  approval: Approval;
  createdAt: string;
  candidate?: string;
};
export class PublishRejected extends Error {}
export class Publisher {
  private root: string;
  private remote: string;
  private env: NodeJS.ProcessEnv;
  constructor(
    root: string,
    destination: Destination,
    options: { token?: string; localRemote?: string } = {},
  ) {
    this.root = root;
    this.remote =
      options.localRemote ?? `https://github.com/${destination.repository}.git`;
    // Do not inherit Git helpers/configuration/hooks from the developer's checkout.
    this.env = {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: options.localRemote ? "file" : "https",
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: "/dev/null",
      GIT_CONFIG_KEY_2: "http.followRedirects",
      GIT_CONFIG_VALUE_2: "false",
      GIT_CONFIG_KEY_3: `http.${this.remote}.extraHeader`,
      GIT_CONFIG_VALUE_3: options.token
        ? `Authorization: Basic ${Buffer.from(`x-access-token:${options.token}`).toString("base64")}`
        : "",
    };
  }
  private async git(
    directory: string,
    args: string[],
    extraEnv: NodeJS.ProcessEnv = {},
  ) {
    try {
      return (
        await exec("git", ["-C", directory, ...args], {
          env: { ...this.env, ...extraEnv },
          timeout: 60_000,
          maxBuffer: 2_000_000,
        })
      ).stdout.trimEnd();
    } catch {
      // Git stderr/exec errors can include authentication material. Never expose them to logs or the agent.
      throw new Error(
        `Git ${args[0]} failed. Check credentials, repository permissions, branch protection, or remote changes.`,
      );
    }
  }
  private directory(job: Publication) {
    return resolve(this.root, job.id);
  }
  async remoteHead(job: Publication) {
    const refs = await this.git(this.directory(job), [
      "ls-remote",
      "--heads",
      this.remote,
      `refs/heads/${job.destination.branch}`,
    ]);
    return refs.split(/\s/)[0] || EMPTY_BASE;
  }
  async prepare(job: Publication): Promise<string> {
    const { approval } = job;
    const digest = createHash("sha256")
      .update(`${approval.baseSha}\n${approval.proposedSha}\n${approval.diff}`)
      .digest("hex");
    if (digest !== approval.digest) throw new Error("Proposal hash mismatch.");
    if (
      Buffer.byteLength(approval.diff) > 262144 ||
      approval.diff.includes("GIT binary patch")
    )
      throw new Error("Only text patches up to 256 KiB are supported.");
    const directory = this.directory(job);
    await mkdir(directory, { recursive: true });
    await this.git(directory, ["init", "--quiet"]);
    await this.git(directory, [
      "check-ref-format",
      `refs/heads/${job.destination.branch}`,
    ]);
    const remote = await this.remoteHead(job);
    if (remote !== approval.baseSha)
      throw new Error(
        "Remote branch changed. Fetch and prepare a new proposal.",
      );
    if (remote === EMPTY_BASE)
      await this.git(directory, ["read-tree", "--empty"]);
    else {
      await this.git(directory, [
        "fetch",
        "--no-tags",
        this.remote,
        `refs/heads/${job.destination.branch}`,
      ]);
      if ((await this.git(directory, ["rev-parse", "FETCH_HEAD"])) !== remote)
        throw new Error("Remote branch changed during validation.");
      await this.git(directory, ["read-tree", remote]);
    }
    await writeFile(resolve(directory, "proposal.patch"), approval.diff, {
      mode: 0o600,
    });
    // Apply to the index only; never execute or check out proposed repository code in PL.
    await this.git(directory, [
      "apply",
      "--cached",
      "--check",
      "proposal.patch",
    ]);
    await this.git(directory, ["apply", "--cached", "proposal.patch"]);
    const files = await this.git(directory, ["ls-files", "--stage", "-z"]);
    for (const file of files.split("\0").filter(Boolean)) {
      const [metadata, path] = file.split("\t");
      if (
        !/^(100644|100755) /.test(metadata!) ||
        !path ||
        path.toLowerCase().startsWith(".github/") ||
        path.split("/").some((component) => component.toLowerCase() === ".git")
      )
        throw new Error(
          "Prototype publication permits regular course files only; GitHub configuration, symlinks and submodules are excluded.",
        );
    }
    const tree = await this.git(directory, ["write-tree"]);
    const candidate = await this.git(
      directory,
      [
        "commit-tree",
        tree,
        ...(remote === EMPTY_BASE ? [] : ["-p", remote]),
        "-m",
        `Approved course-agent change ${job.id}`,
      ],
      {
        GIT_AUTHOR_NAME: "Course agent prototype",
        GIT_AUTHOR_EMAIL: "course-agent@example.invalid",
        GIT_COMMITTER_NAME: "Course agent prototype",
        GIT_COMMITTER_EMAIL: "course-agent@example.invalid",
        GIT_AUTHOR_DATE: job.createdAt,
        GIT_COMMITTER_DATE: job.createdAt,
      },
    );
    return candidate;
  }
  async push(job: Publication): Promise<string> {
    if (!job.candidate) throw new Error("Proposal has not been validated.");
    const head = await this.remoteHead(job);
    if (head === job.candidate) return job.candidate; // Recovery after a successful push with a lost acknowledgment.
    if (head !== job.approval.baseSha) {
      if (head !== EMPTY_BASE) {
        await this.git(this.directory(job), [
          "fetch",
          "--no-tags",
          this.remote,
          `refs/heads/${job.destination.branch}`,
        ]);
        try {
          await this.git(this.directory(job), [
            "merge-base",
            "--is-ancestor",
            job.candidate,
            "FETCH_HEAD",
          ]);
          return job.candidate;
        } catch {
          /* A different remote history is a conflict. */
        }
      }
      throw new PublishRejected(
        "Remote branch changed after approval. Prepare a new proposal.",
      );
    }
    try {
      await this.git(this.directory(job), [
        "push",
        this.remote,
        `${job.candidate}:refs/heads/${job.destination.branch}`,
      ]);
    } catch (error) {
      const current = await this.remoteHead(job); // Unknown network outcome stays queued until it can be reconciled.
      if (current === job.candidate) return job.candidate;
      if (current !== head) return this.push(job);
      throw new PublishRejected(
        error instanceof Error ? error.message : "Git push was rejected.",
      );
    }
    return job.candidate;
  }
}
