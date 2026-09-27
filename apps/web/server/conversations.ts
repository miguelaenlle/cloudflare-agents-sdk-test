import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  ChatError,
  type ChatSnapshot,
  type SendRequest,
} from "@playground/chat-contract";
const blocks = (
  await readFile(new URL("./conversations.sql", import.meta.url), "utf8")
)
  .split(/^-- BLOCK /m)
  .slice(1);
const statements = new Map(
  blocks.map((block) => [
    block.slice(0, block.indexOf("\n")).trim(),
    block.slice(block.indexOf("\n") + 1),
  ]),
);
function sql(name: string) {
  const statement = statements.get(name);
  if (!statement) throw new Error(`Missing SQL block: ${name}`);
  return statement;
}
const connectionString =
  process.env.DATABASE_URL ?? "postgresql://localhost/course_agent";
export const db = new pg.Pool({ connectionString });
await db.query(
  await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
);

/** LISTEN is established before reading a snapshot, so no change can fall into a subscription gap. */
export async function subscribe(
  id: string,
  changed: () => void,
  failed: () => void,
) {
  const client = new pg.Client({ connectionString });
  client.on("error", failed);
  client.on("end", failed);
  client.on("notification", (event) => {
    if (event.payload === id) changed();
  });
  await client.connect();
  await client.query(sql("listen"));
  return () => {
    client.removeAllListeners();
    void client.end();
  };
}
async function notify(id: string) {
  await db.query(sql("notify"), [id]);
}
export async function listConversations() {
  return (await db.query(sql("list_conversations"))).rows;
}
export async function createConversation(title: string) {
  const value = { id: randomUUID(), title };
  await db.query(sql("insert_conversation"), [value.id, title]);
  return value;
}
export async function hasConversation(id: string) {
  return !!(await db.query(sql("has_conversation"), [id])).rowCount;
}

/** Reserve admission atomically across tabs and relay instances. A retry with the same payload keeps its revision. */
export async function reserve(
  id: string,
  operation: string,
  payload: unknown,
  expected: number,
) {
  const client = await db.connect();
  try {
    await client.query(sql("begin"));
    const row = (await client.query(sql("lock_conversation"), [id])).rows[0];
    if (!row) throw new ChatError(404, "Conversation not found.");
    const existing = (
      await client.query(sql("select_operation"), [id, operation])
    ).rows[0];
    if (existing) {
      const same = (
        await client.query(sql("same_operation"), [
          id,
          operation,
          JSON.stringify(payload),
        ])
      ).rows[0].same;
      if (!same)
        throw new ChatError(
          409,
          "Operation ID was reused with different input.",
        );
      await client.query(sql("commit"));
      return Number(existing.revision);
    }
    if (Number(row.revision) !== expected)
      throw new ChatError(
        409,
        "This conversation changed. Refresh history; your draft is preserved.",
      );
    const revision = expected + 1;
    await client.query(sql("advance_revision"), [id, revision]);
    await client.query(sql("insert_operation"), [
      id,
      operation,
      JSON.stringify(payload),
      revision,
    ]);
    await client.query(sql("notify"), [id]);
    await client.query(sql("commit"));
    return revision;
  } catch (error) {
    await client.query(sql("rollback"));
    throw error;
  } finally {
    client.release();
  }
}
export async function admit(id: string, input: SendRequest) {
  return reserve(
    id,
    input.id,
    { kind: "message", text: input.text },
    input.expectedRevision,
  );
}
/** Combine provider-owned chat state with the relay's admission revision. */
export async function conversationSnapshot(
  id: string,
  snapshot: ChatSnapshot,
): Promise<ChatSnapshot> {
  const revision = Number(
    (await db.query(sql("select_revision"), [id])).rows[0]?.revision ?? 0,
  );
  return { ...snapshot, revision };
}
