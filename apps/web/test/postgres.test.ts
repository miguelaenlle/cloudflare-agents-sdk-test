import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { randomUUID, createHash } from "node:crypto";
import type { ChatProvider } from "@playground/chat-contract";

const schema = `test_${randomUUID().replaceAll("-", "")}`;
const url = new URL(
  process.env.DATABASE_URL ?? "postgresql://localhost/course_agent",
);
const admin = new pg.Client({ connectionString: url.toString() });
await admin.connect();
await admin.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set("options", `-c search_path=${schema}`);
process.env.DATABASE_URL = url.toString();
process.env.PUSH_MODE = "simulated";
const store = await import("../server/conversations.ts");

test("Postgres admissions, notification delivery, and durable manual Retry", async (t) => {
  try {
    await t.test(
      "only one competing revision is admitted; same operation is idempotent",
      async () => {
        const convo = await store.createConversation("Concurrent tabs");
        const first = { id: randomUUID(), text: "one", expectedRevision: 0 };
        const second = { id: randomUUID(), text: "two", expectedRevision: 0 };
        const results = await Promise.allSettled([
          store.admit(convo.id, first),
          store.admit(convo.id, second),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        const winner = results[0].status === "fulfilled" ? first : second;
        assert.equal(await store.admit(convo.id, winner), 1);
        await assert.rejects(
          store.admit(convo.id, { ...winner, text: "different" }),
          /different input/,
        );
      },
    );
    await t.test("LISTEN observes a mutation after subscription", async () => {
      const convo = await store.createConversation("Events");
      let resolve!: () => void;
      const notified = new Promise<void>((r) => {
        resolve = r;
      });
      const close = await store.subscribe(convo.id, resolve, () => {});
      try {
        await store.admit(convo.id, {
          id: randomUUID(),
          text: "event",
          expectedRevision: 0,
        });
        await Promise.race([
          notified,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Notification lost")), 2000),
          ),
        ]);
      } finally {
        close();
      }
    });
    await t.test(
      "decision survives failed delivery; explicit Retry preserves the verdict and revision",
      async () => {
        const convo = await store.createConversation("Retry");
        const id = randomUUID();
        const files = [
          {
            path: "a",
            content: "hello",
            mode: "100644",
            previousMode: "000000",
          },
        ];
        const baseSha = "a".repeat(40),
          proposedSha = "b".repeat(40);
        const approval = {
          id,
          baseSha,
          proposedSha,
          files,
          diff: "raw diff",
          digest: createHash("sha256")
            .update(`${baseSha}\n${proposedSha}\n${JSON.stringify(files)}`)
            .digest("hex"),
          status: "pending" as const,
        };
        const initial = {
          messages: [],
          revision: 0,
          blocked: true,
          pendingTool: { id, sequence: 1, name: "push_sync", args: approval },
        };
        await store.publicationSnapshot(convo.id, initial);
        let deliveries = 0;
        const chat = {
          deliverToolResult: async () => {
            deliveries++;
            if (deliveries === 1) throw new Error("delivery failed");
          },
        } as unknown as ChatProvider;
        const decision = {
          id,
          digest: approval.digest,
          approved: true,
          expectedRevision: 0,
        };
        await assert.rejects(
          store.recordDecision(convo.id, decision, chat),
          /delivery failed/,
        );
        await assert.rejects(
          store.admit(convo.id, {
            id: randomUUID(),
            text: "bypass",
            expectedRevision: 1,
          }),
          /pending publication/,
        );
        const newer = {
          ...initial,
          pendingTool: {
            ...initial.pendingTool,
            id: randomUUID(),
            sequence: 2,
          },
        };
        assert.equal(
          (await store.publicationSnapshot(convo.id, newer)).approval?.id,
          id,
        );
        const failed = await store.publicationSnapshot(convo.id, initial);
        assert.equal(failed.approval?.status, "approved");
        assert.equal(failed.revision, 1);
        await store.recordDecision(convo.id, decision, chat);
        await store.recordDecision(convo.id, decision, chat);
        assert.equal(deliveries, 2);
        await assert.rejects(
          store.recordDecision(
            convo.id,
            { ...decision, approved: false },
            chat,
          ),
          /different input/,
        );
        await store.publicationSnapshot(convo.id, newer);
        await store.publicationSnapshot(convo.id, initial); // A delayed old snapshot must not replace the new record.
        const rows = await store.db.query(
          "SELECT id FROM publications WHERE conversation_id=$1",
          [convo.id],
        );
        assert.deepEqual(
          rows.rows.map((r) => r.id),
          [newer.pendingTool.id],
        );
        await assert.rejects(
          store.recordDecision(convo.id, decision, chat),
          /Proposal changed/,
        );
      },
    );
  } finally {
    await store.db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
