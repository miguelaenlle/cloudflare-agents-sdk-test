import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  ChatError,
  approvalDisplaySchema,
  type ApprovalDecision,
  type ApprovalDisplay,
  type ChatSnapshot,
  type ChatProvider,
  type SendRequest,
} from "@playground/chat-contract";
import { Publisher, PublishRejected, type Publication } from "./publish.ts";
import { prepareTool, historicalApprovals } from "./tools.ts";

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
const simulated = process.env.PUSH_MODE === "simulated";

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
    if (
      typeof payload === "object" &&
      payload !== null &&
      "kind" in payload &&
      payload.kind === "message" &&
      (await client.query(sql("pending_publication"), [id])).rowCount
    )
      throw new ChatError(
        409,
        "Resolve the pending publication before sending another message.",
      );
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
function publisher(job: Publication) {
  const token = process.env.GITHUB_TOKEN;
  if (!token)
    throw new Error(
      "Set GITHUB_TOKEN on the PL relay to enable approved pushes.",
    );
  return new Publisher(job.destination, { token });
}
async function row(id: string) {
  return (await db.query(sql("select_publication"), [id])).rows[0];
}

/** The DO transports a generic immutable payload; PL stores the proposal and owns its user decision. */
export async function publicationSnapshot(
  id: string,
  snapshot: ChatSnapshot,
): Promise<ChatSnapshot> {
  const tool = snapshot.pendingTool;
  if (tool) {
    const job = prepareTool(tool);
    await db.query(sql("insert_publication"), [
      job.id,
      id,
      JSON.stringify(job),
    ]);
  }
  const jobs = (await db.query(sql("list_publications"), [id])).rows;
  const currentApprovals: ApprovalDisplay[] = jobs.map((r) => ({
    ...approvalDisplaySchema.parse(r.job.approval),
    status: r.decision
      ? r.decision.approved
        ? "approved"
        : "denied"
      : "pending",
    result: r.outcome?.result,
  }));
  const approvals = [
    ...historicalApprovals(snapshot.messages).filter(
      (old) => !currentApprovals.some((a) => a.id === old.id),
    ),
    ...currentApprovals,
  ];
  const current = jobs.find((r) => r.id === tool?.id) ?? jobs.at(-1);
  let publication: ChatSnapshot["publication"];
  if (current && !current.delivered) {
    let error: string | undefined;
    if (!current.job.candidate && !simulated) {
      try {
        current.job.candidate = await publisher(current.job).prepare(
          current.job,
        );
        await db.query(sql("save_candidate"), [
          current.id,
          JSON.stringify(current.job),
        ]);
        const index = approvals.findIndex((a) => a.id === current.id);
        approvals[index] = {
          ...approvals[index]!,
          diff: current.job.approval.diff,
        };
      } catch (failure) {
        error =
          failure instanceof Error
            ? failure.message
            : "Proposal validation failed.";
      }
    }
    publication = {
      ...current.job.destination,
      status: current.decision ? "publishing" : error ? "invalid" : "ready",
      decision: current.decision?.approved,
      error,
    };
  }
  const revision = Number(
    (await db.query(sql("select_revision"), [id])).rows[0]?.revision ?? 0,
  );
  return {
    ...snapshot,
    revision,
    approval: approvals.find((a) => a.id === current?.id),
    approvals,
    publication,
  };
}

/** A session advisory lock serializes Retry across webservers and is released when a crashed connection closes. */
export async function recordDecision(
  id: string,
  input: ApprovalDecision,
  chat: ChatProvider,
) {
  const client = await db.connect();
  const key = `publication:${input.id}`;
  let locked = false;
  try {
    locked = (await client.query(sql("claim_publication"), [key])).rows[0]
      .locked;
    if (!locked)
      throw new ChatError(
        409,
        "This decision is still processing. Retry shortly.",
      );
    let saved = await row(input.id);
    if (
      !saved ||
      saved.conversation_id !== id ||
      saved.job.approval.digest !== input.digest
    )
      throw new ChatError(409, "Proposal changed. Refresh before deciding.");
    await reserve(
      id,
      `decision:${input.id}`,
      { digest: input.digest, approved: input.approved },
      input.expectedRevision,
    );
    if (saved.decision && saved.decision.approved !== input.approved)
      throw new ChatError(409, "A different decision is already recorded.");
    await db.query(sql("save_decision"), [input.id, JSON.stringify(input)]);
    await notify(id);
    saved = await row(input.id);
    if (!saved.outcome) {
      let result: string;
      if (!input.approved)
        result = "The user denied this proposal. No changes were published.";
      else if (simulated)
        result =
          "Approved. sync would go here. SIMULATION ONLY: no commit was published and no sync ran.";
      else {
        const job: Publication = saved.job;
        if (!job.candidate)
          throw new Error(
            "Proposal has not been validated. Refresh and Retry.",
          );
        try {
          const sha = saved.published_sha ?? (await publisher(job).push(job));
          // Checkpoint publication before sync; Retry reconciles an uncertain GitHub acknowledgment.
          await db.query(sql("save_sha"), [input.id, sha]);
          console.log(`Approval ${input.id}: sync would go here`);
          result = `Push succeeded: ${job.destination.repository} branch ${job.destination.branch}, commit ${sha}. Course Sync: simulated (sync would go here). Run git fetch origin, reconcile your checkout with ${sha} while preserving newer edits, then git pull --ff-only before continuing.`;
        } catch (error) {
          if (!(error instanceof PublishRejected)) throw error;
          result = `Publication failed: ${error.message} Course Sync did not run. Prepare a new proposal.`;
        }
      }
      await db.query(sql("save_outcome"), [
        input.id,
        JSON.stringify({ id: input.id, result }),
      ]);
      saved = await row(input.id);
    }
    if (!saved.delivered) {
      await chat.deliverToolResult(
        {
          ...saved.outcome,
          display: {
            name: "push_sync",
            value: {
              ...approvalDisplaySchema.parse(saved.job.approval),
              status: saved.decision.approved ? "approved" : "denied",
              result: saved.outcome.result,
            },
          },
        },
        AbortSignal.timeout(30_000),
      );
      await db.query(sql("mark_delivered"), [input.id]);
    }
    await notify(id);
  } finally {
    if (locked) await client.query(sql("release_publication"), [key]);
    client.release();
  }
}
