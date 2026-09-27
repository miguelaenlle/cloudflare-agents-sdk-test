import assert from "node:assert/strict";
import { test } from "node:test";
import { forwardGitHub } from "../outbound.ts";
import { GITHUB_REPOSITORY } from "@playground/chat-contract";
test("Git credential injection only permits configured repository reads and blocks redirects", async () => {
  let calls = 0;
  const env = {
    GITHUB_TOKEN: "private-token",
  };
  const send: typeof fetch = async (input) => {
    calls++;
    assert.ok(input instanceof Request);
    assert.equal(
      input.url,
      "https://github.com/miguelaenlle/course-agent-push-sync-test.git/info/refs?service=git-upload-pack",
    );
    assert.equal(
      input.headers.get("Authorization"),
      `Basic ${btoa("x-access-token:private-token")}`,
    );
    assert.equal(input.headers.has("cookie"), false);
    return new Response("refs");
  };
  for (const scheme of ["http", "https"]) {
    assert.equal(
      (
        await forwardGitHub(
          new Request(
            `${scheme}://github.com/miguelaenlle/course-agent-push-sync-test.git/info/refs?service=git-upload-pack`,
            { headers: { cookie: "untrusted" } },
          ),
          env,
          send,
        )
      ).status,
      200,
    );
  }
  for (const url of [
    "https://github.com/other/repo.git/info/refs?service=git-upload-pack",
    "https://github.com/miguelaenlle/course-agent-push-sync-test.git/git-receive-pack",
    "https://github.com/miguelaenlle/course-agent-push-sync-test.git/info/refs?service=git-receive-pack",
    "https://github.com/miguelaenlle/course-agent-push-sync-test.git/info/refs?service=git-upload-pack&other=1",
  ]) {
    assert.equal(
      (await forwardGitHub(new Request(url), env, send)).status,
      403,
    );
  }
  assert.equal(calls, 2);
  assert.equal(
    (
      await forwardGitHub(
        new Request(
          "https://github.com/miguelaenlle/course-agent-push-sync-test.git/info/refs?service=git-upload-pack",
        ),
        env,
        async () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://evil.test" },
          }),
      )
    ).status,
    502,
  );
});
