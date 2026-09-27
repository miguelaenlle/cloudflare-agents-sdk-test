import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import pg from "pg";
import {
  proposalContent,
  type ChatProvider,
  type ToolOutcome,
} from "@playground/chat-contract";

const schema = `test_${randomUUID().replaceAll("-", "")}`;
const url = new URL(
  process.env.DATABASE_URL ?? "postgresql://localhost/course_agent",
);
const admin = new pg.Client({ connectionString: url.toString() });
await admin.connect();
await admin.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set("options", `-c search_path=${schema}`);
process.env.DATABASE_URL = url.toString();
process.env.PUSH_MODE = "github";
process.env.GITHUB_TOKEN = "fixture-token";
const store = await import("../server/conversations.ts");
const originalFetch = globalThis.fetch;

test("publication outcomes archive through generic result delivery before replacement", async (t) => {
  try {
    for (const rejected of [false, true]) {
      await t.test(
        rejected ? "branch conflict" : "published commit",
        async () => {
          const conversation = await store.createConversation("Publication");
          const id = randomUUID();
          const baseSha = "a".repeat(40),
            proposedSha = "b".repeat(40);
          const files = [
            {
              path: "new.txt",
              content: "hello\n",
              mode: "100644",
              previousMode: "000000",
            },
          ];
          const approval = {
            id,
            baseSha,
            proposedSha,
            files,
            diff: "untrusted",
            status: "pending",
            digest: createHash("sha256")
              .update(proposalContent(baseSha, proposedSha, files))
              .digest("hex"),
          };
          let writes = 0;
          globalThis.fetch = async (url, options) => {
            if (String(url).includes("/git/trees/"))
              return Response.json({ truncated: false, tree: [] });
            assert.equal(String(url), "https://api.github.com/graphql");
            const body = JSON.parse(String(options?.body));
            if (body.query.startsWith("query"))
              return Response.json({
                data: {
                  repository: {
                    ref: {
                      target: {
                        history: {
                          nodes: [
                            ...(rejected
                              ? [
                                  {
                                    oid: "d".repeat(40),
                                    message: "concurrent commit",
                                  },
                                ]
                              : []),
                            { oid: baseSha, message: "base" },
                          ],
                          pageInfo: { hasNextPage: false },
                        },
                      },
                    },
                  },
                },
              });
            writes++;
            return Response.json({
              data: {
                createCommitOnBranch: { commit: { oid: "c".repeat(40) } },
              },
            });
          };
          await store.publicationSnapshot(conversation.id, {
            messages: [],
            revision: 0,
            pendingTool: { id, sequence: 1, name: "push_sync", args: approval },
          });
          let calls = 0;
          let outcome: ToolOutcome | undefined;
          const chat = {
            deliverToolResult: async (input: ToolOutcome) => {
              calls++;
              outcome = input;
              if (calls === 1) throw new Error("lost delivery");
            },
          } as unknown as ChatProvider;
          const decision = {
            id,
            digest: approval.digest,
            approved: true,
            expectedRevision: 0,
          };
          await assert.rejects(
            store.recordDecision(conversation.id, decision, chat),
            /lost delivery/,
          );
          assert.equal(
            (
              await store.db.query(
                "SELECT delivered FROM publications WHERE id=$1",
                [id],
              )
            ).rows[0].delivered,
            false,
          );
          await store.recordDecision(conversation.id, decision, chat);
          assert.equal(writes, rejected ? 0 : 1);
          assert.equal(outcome!.display!.name, "push_sync");
          assert.match(
            outcome!.result,
            rejected ? /Publication failed/ : /Push succeeded/,
          );
          assert.equal("files" in (outcome!.display!.value as object), false);
          assert.equal(
            (
              await store.db.query(
                "SELECT delivered FROM publications WHERE id=$1",
                [id],
              )
            ).rows[0].delivered,
            true,
          );
        },
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    await store.db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
