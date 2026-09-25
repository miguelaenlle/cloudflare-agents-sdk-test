import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ChatError,
  approvalOutcomeSchema,
  type ApprovalDecision,
} from "@playground/chat-contract";

const path = resolve(process.env.CHAT_DB_PATH ?? ".data/chat.sqlite");
mkdirSync(dirname(path), { recursive: true });
const db = new DatabaseSync(path);
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS approval_decisions (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO conversations VALUES ('playground', 'Playground');`);
export function listConversations() {
  return db
    .prepare("SELECT id, title FROM conversations ORDER BY rowid DESC")
    .all();
}
export function createConversation(title: string) {
  const conversation = { id: randomUUID(), title };
  db.prepare("INSERT INTO conversations VALUES (?, ?)").run(
    conversation.id,
    title,
  );
  return conversation;
}
export function hasConversation(id: string) {
  return !!db.prepare("SELECT id FROM conversations WHERE id = ?").get(id);
}

export async function recordDecision(
  conversationId: string,
  input: ApprovalDecision,
) {
  const existing = db
    .prepare(
      "SELECT payload, conversation_id FROM approval_decisions WHERE id = ?",
    )
    .get(input.id);
  if (existing) {
    const value = approvalOutcomeSchema.parse(
      JSON.parse(String(existing.payload)),
    );
    if (
      existing.conversation_id !== conversationId ||
      value.digest !== input.digest ||
      value.approved !== input.approved
    )
      throw new ChatError(409, "A different decision was already recorded.");
    return value;
  }
  const result = input.approved
    ? "Approved. sync would go here. SIMULATION ONLY: no commit was published and no sync ran."
    : "The user denied this proposal. No changes were published.";
  const value = { ...input, result };
  db.prepare(
    "INSERT INTO approval_decisions (id, conversation_id, payload) VALUES (?, ?, ?)",
  ).run(input.id, conversationId, JSON.stringify(value));
  return value;
}
export function pendingDecisions() {
  return db
    .prepare(
      "SELECT conversation_id, payload FROM approval_decisions WHERE delivered = 0",
    )
    .all()
    .map((row) => ({
      conversationId: String(row.conversation_id),
      input: approvalOutcomeSchema.parse(JSON.parse(String(row.payload))),
    }));
}
export function deliveredDecision(id: string) {
  db.prepare("UPDATE approval_decisions SET delivered = 1 WHERE id = ?").run(
    id,
  );
}
