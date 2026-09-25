import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { Publisher, EMPTY_BASE, type Publication } from "../server/publish.ts";
const exec = promisify(execFile);
async function git(directory: string, ...args: string[]) {
  return (await exec("git", ["-C", directory, ...args])).stdout.trim();
}
function job(baseSha: string, diff: string): Publication {
  const proposedSha = "a".repeat(40);
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    destination: { repository: "owner/test", branch: "main" },
    approval: {
      id: randomUUID(),
      baseSha,
      proposedSha,
      diff,
      status: "pending",
      digest: createHash("sha256")
        .update(`${baseSha}\n${proposedSha}\n${diff}`)
        .digest("hex"),
    },
  };
}
const patch =
  "diff --git a/hello.txt b/hello.txt\nnew file mode 100644\n--- /dev/null\n+++ b/hello.txt\n@@ -0,0 +1 @@\n+hello\n";
test("real pushes: empty branch, approved patch, duplicate recovery, stale base, and unsafe files", async () => {
  const root = await mkdtemp(join(tmpdir(), "publish-test-"));
  try {
    await exec("git", ["init", "--bare", join(root, "remote.git")]);
    const remote = join(root, "remote.git");
    const publisher = new Publisher(
      join(root, "jobs"),
      { repository: "owner/test", branch: "main" },
      { localRemote: remote },
    );
    const first = job(EMPTY_BASE, patch);
    first.candidate = await publisher.prepare(first);
    assert.equal(
      await git(
        remote,
        "for-each-ref",
        "--format=%(objectname)",
        "refs/heads/main",
      ),
      "",
    );
    assert.equal(await publisher.push(first), first.candidate);
    assert.equal(
      await git(remote, "show", "refs/heads/main:hello.txt"),
      "hello",
    );
    assert.equal(await publisher.push(first), first.candidate);
    assert.equal(
      await git(remote, "rev-list", "--count", "refs/heads/main"),
      "1",
    );
    const change =
      "diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hello\n+updated\n";
    const second = job(first.candidate, change);
    second.candidate = await publisher.prepare(second);
    const stale = job(first.candidate, change.replace("updated", "stale"));
    stale.candidate = await publisher.prepare(stale);
    await publisher.push(second);
    await assert.rejects(publisher.push(stale), /Remote branch changed/);
    assert.equal(
      await git(remote, "show", "refs/heads/main:hello.txt"),
      "updated",
    );
    assert.equal(await publisher.push(first), first.candidate); // Lost ACK, followed by another valid commit.
    const tampered = job(second.candidate, patch);
    tampered.approval.digest = "wrong";
    await assert.rejects(publisher.prepare(tampered), /hash mismatch/);
    const symlink = job(
      second.candidate,
      patch.replaceAll("hello.txt", "link").replace("100644", "120000"),
    );
    await assert.rejects(publisher.prepare(symlink), /regular course files/);
    const workflow = job(
      second.candidate,
      patch.replaceAll("hello.txt", ".github/workflows/run.yml"),
    );
    await assert.rejects(publisher.prepare(workflow), /regular course files/);
    const escape = job(
      second.candidate,
      patch.replaceAll("hello.txt", "../outside"),
    );
    await assert.rejects(publisher.prepare(escape));
    const binary = job(second.candidate, "GIT binary patch");
    await assert.rejects(publisher.prepare(binary), /Only text patches/);
    // The credential is passed in process configuration, never persisted in repository config.
    const config = await git(
      join(root, "jobs", first.id),
      "config",
      "--local",
      "--list",
    );
    assert.equal(config.includes("extraheader"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
