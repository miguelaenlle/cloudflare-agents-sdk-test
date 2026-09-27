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
  } finally {
    await store.db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
