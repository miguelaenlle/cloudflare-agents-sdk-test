import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
const path = resolve(process.env.CHAT_DB_PATH ?? ".data/chat.sqlite");
mkdirSync(dirname(path), { recursive: true });
const db = new DatabaseSync(path);
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL);
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
