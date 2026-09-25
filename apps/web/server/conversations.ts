import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ChatError,
  approvalOutcomeSchema,
  type ApprovalDecision,
  type Approval,
  type ChatSnapshot,
} from "@playground/chat-contract";

import {
  Publisher,
  PublishRejected,
  destination,
  type Publication,
} from "./publish.ts";

const path = resolve(process.env.CHAT_DB_PATH ?? ".data/chat.sqlite");
mkdirSync(dirname(path), { recursive: true });
const db = new DatabaseSync(path);
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS approval_decisions (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS publications (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, job TEXT NOT NULL, decision TEXT);
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
const preparing = new Map<string, Promise<Publication>>();
const publishing = new Map<
  string,
  Promise<ReturnType<typeof approvalOutcomeSchema.parse>>
>();
const simulated = process.env.PUSH_MODE === "simulated";
function publisher(job: Publication) {
  const token = process.env.GITHUB_TOKEN;
  if (!token)
    throw new Error(
      "Set GITHUB_TOKEN on the PL relay to enable approved pushes.",
    );
  return new Publisher(resolve(dirname(path), "publish"), job.destination, {
    token,
  });
}
function readJob(id: string) {
  const row = db.prepare("SELECT job FROM publications WHERE id = ?").get(id);
  return row ? (JSON.parse(String(row.job)) as Publication) : undefined;
}
function prepare(
  conversationId: string,
  approval: Approval,
): Promise<Publication> {
  const key = `${conversationId}:${approval.id}`;
  const previous = preparing.get(key);
  if (previous)
    return previous.then((job) => {
      if (job.approval.digest !== approval.digest)
        throw new ChatError(409, "Approval payload changed.");
      return job;
    });
  const task = (async () => {
    const owner = db
      .prepare("SELECT conversation_id FROM publications WHERE id = ?")
      .get(approval.id);
    if (owner && owner.conversation_id !== conversationId)
      throw new ChatError(409, "Approval belongs to another conversation.");
    let job = readJob(approval.id);
    if (!job) {
      job = {
        id: approval.id,
        destination: destination(),
        approval,
        createdAt: new Date().toISOString(),
      };
      db.prepare(
        "INSERT INTO publications (id, conversation_id, job) VALUES (?, ?, ?)",
      ).run(job.id, conversationId, JSON.stringify(job));
    }
    if (job.approval.digest !== approval.digest)
      throw new ChatError(409, "Approval payload changed.");
    if (!job.candidate) {
      job.candidate = await publisher(job).prepare(job);
      db.prepare("UPDATE publications SET job = ? WHERE id = ?").run(
        JSON.stringify(job),
        job.id,
      );
    }
    return job;
  })();
  preparing.set(key, task);
  return task;
}
export async function publicationSnapshot(
  conversationId: string,
  snapshot: ChatSnapshot,
): Promise<ChatSnapshot> {
  if (simulated || !snapshot.approval || snapshot.approval.status !== "pending")
    return snapshot;
  const pending = db
    .prepare("SELECT decision FROM publications WHERE id = ?")
    .get(snapshot.approval.id)?.decision;
  try {
    const job = await prepare(conversationId, snapshot.approval);
    return {
      ...snapshot,
      publication: {
        ...job.destination,
        status: pending ? "publishing" : "ready",
      },
    };
  } catch (error) {
    return {
      ...snapshot,
      publication: {
        ...(readJob(snapshot.approval.id)?.destination ?? destination()),
        status: "invalid",
        error:
          error instanceof Error
            ? error.message
            : "Proposal validation failed.",
      },
    };
  }
}
function saveOutcome(
  conversationId: string,
  input: ApprovalDecision,
  result: string,
) {
  const value = { ...input, result };
  db.prepare(
    "INSERT OR IGNORE INTO approval_decisions (id, conversation_id, payload) VALUES (?, ?, ?)",
  ).run(input.id, conversationId, JSON.stringify(value));
  return value;
}
async function publishDecision(
  conversationId: string,
  input: ApprovalDecision,
) {
  const previous = publishing.get(input.id);
  if (previous) return previous;
  const task = (async () => {
    const saved = db
      .prepare("SELECT payload FROM approval_decisions WHERE id = ?")
      .get(input.id);
    if (saved)
      return approvalOutcomeSchema.parse(JSON.parse(String(saved.payload)));
    const job = readJob(input.id)!;
    try {
      const sha = await publisher(job).push(job);
      console.log(`Approval ${input.id}: pushed ${sha}; sync would go here`);
      return saveOutcome(
        conversationId,
        input,
        `Push succeeded: ${job.destination.repository} branch ${job.destination.branch}, commit ${sha}. Course Sync: simulated (sync would go here). Run git fetch origin, reconcile your checkout with ${sha} while preserving any newer edits, then git pull --ff-only before continuing. PL applied the approved patch as a new commit, so its SHA can differ from your proposed commit.`,
      );
    } catch (error) {
      if (!(error instanceof PublishRejected)) throw error;
      return saveOutcome(
        conversationId,
        input,
        `Push failed: ${error.message} Course Sync did not run. Fetch the remote branch and prepare a new proposal.`,
      );
    }
  })().finally(() => publishing.delete(input.id));
  publishing.set(input.id, task);
  return task;
}
export async function recordDecision(
  conversationId: string,
  input: ApprovalDecision,
  approval: Approval,
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
  const recorded = db
    .prepare("SELECT decision FROM publications WHERE id = ?")
    .get(input.id)?.decision;
  if (recorded && JSON.parse(String(recorded)).approved !== input.approved)
    throw new ChatError(409, "A different decision was already recorded.");
  if (!input.approved)
    return saveOutcome(
      conversationId,
      input,
      "The user denied this proposal. No changes were published.",
    );
  if (simulated)
    return saveOutcome(
      conversationId,
      input,
      "Approved. sync would go here. SIMULATION ONLY: no commit was published and no sync ran.",
    );
  await prepare(conversationId, approval);
  db.prepare(
    "UPDATE publications SET decision = ? WHERE id = ? AND decision IS NULL",
  ).run(JSON.stringify(input), input.id);
  const chosen = JSON.parse(
    String(
      db
        .prepare("SELECT decision FROM publications WHERE id = ?")
        .get(input.id)!.decision,
    ),
  ) as ApprovalDecision;
  if (chosen.approved !== input.approved)
    throw new ChatError(409, "A different decision was already recorded.");
  return publishDecision(conversationId, chosen);
}
export async function retryPublications() {
  const rows = db
    .prepare(
      "SELECT p.conversation_id, p.decision FROM publications p LEFT JOIN approval_decisions d ON p.id = d.id WHERE p.decision IS NOT NULL AND d.id IS NULL",
    )
    .all();
  for (const row of rows) {
    try {
      await publishDecision(
        String(row.conversation_id),
        JSON.parse(String(row.decision)) as ApprovalDecision,
      );
    } catch {
      /* Preserve uncertain pushes for reconciliation after connection/credential recovery. */
    }
  }
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
