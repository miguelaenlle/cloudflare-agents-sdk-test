# Durable push-sync over the relay WebSocket

## Review order

1. `apps/web/server/host-tools.ts` and `server.ts`: explicit host-call dispatch. Reading a snapshot never prepares or publishes anything.
2. `apps/web/server/conversations.ts`: save the proposal, accept the decision, publish, and deliver the outcome. Postgres owns PL state.
3. `apps/web/server/publish.ts`: GitHub API writes, expected-head protection, and reconciliation after uncertain success. No checkout exists on the relay.
4. `apps/agent/agent.ts`: generic pending-call gate, preparation acknowledgment, result correlation, and recovery.
5. `apps/agent/approval.ts`: Node-based immutable file capture. `apps/web/client/app.tsx`: small persistent approval cards.

## Ownership and transport

Codex requests `push_sync(baseSha, proposedSha)`. The sandbox adapter captures committed final file contents and a raw diff; subsequent worktree edits cannot change the proposal. The DO persists a generic pending call and sends `host-tool-call` over one authenticated relay watch socket. PL validates and saves the proposal, then replies `host-tool-prepared`. Snapshots only hydrate the UI from saved data.

The same repository-scoped PAT is configured on the Worker and relay. Sandbox Git requests only receive read credentials through the restricted outbound handler; approved writes happen through the relay's GitHub API client. Initialize the test repository with a commit before use. The prototype supports UTF-8 ordinary text files, not executable files, symlinks, binary files, or submodules. Proposals are limited to 100 files and 256 KiB of file content; PL reconstructs the raw visual diff from trusted base blobs and the saved contents.

The DO blocks new messages while capture/a durable tool is pending. PL also rejects messages while its latest publication is unresolved. These are server checks; disabling frontend input is only a convenience. Read/status/result requests remain available.

After preparation is acknowledged, normal idle shutdown is allowed. A durable 15-second preparation deadline records a reconnect error and permits idle cleanup if PL is unavailable. The immutable captured payload is already in DO storage, so reconnect can retry preparation with the same operation ID after suspension. There is no timer limiting how long a user may review. Existing interaction expiration and checkpoint retention still apply.

## Decisions and recovery

Approve saves the decision, publishes the exact saved contents, prints the simulated Course Sync operation, saves the outcome, and delivers it. Deny saves a no-publication outcome. Concurrent decisions are serialized by a Postgres advisory lock. Conflicting decisions are rejected.

Results use `host-tool-result` and `host-tool-delivered` frames on an existing relay watch socket. If no watch socket exists, the relay opens a short-lived authenticated socket for delivery. A disconnect or lost acknowledgment leaves the saved outcome retryable; it does not change the decision or authorize another commit.

A warm native call receives its tool result directly. After sandbox shutdown, the DO restores the latest checkpoint and submits a hidden continuation containing the outcome. This restores files and saved Codex context, not the old process or its RPC promise. A missing/expired checkpoint uses the existing fresh-workspace warning; it cannot recover lost uncheckpointed work. An uncertain native submission stays fenced until reconciled rather than being blindly submitted again.

PL keeps one latest publication per conversation. Completed cards are retained in DO chat history without retaining a second set of file blobs. An old proposal cannot replace a newer one. The DO retains the latest delivery receipt for duplicate acknowledgments. Publication retries are explicit user actions; no publication polling loop runs.

Preparation errors have a Retry preparation button. Publication/delivery errors preserve the decision and have Retry completion. If GitHub's acknowledgment was lost, retry searches for the operation's marked commit before attempting another write. The branch expected-head check prevents overwriting concurrent changes. Course Sync is a printout in this prototype; production sync must have equivalent retry semantics.

## Local tests — no cloud usage or model calls

Have local Postgres running with a separate prototype database. These commands use isolated temporary schemas and local Wrangler fixture workers; GitHub requests are mocked and sandbox operations use a native-protocol fixture.

```sh
pnpm --filter @playground/agent test
pnpm --filter @playground/web exec node --experimental-strip-types --test test/host-tools.test.ts test/durable-tools.test.ts test/postgres.test.ts test/publication-flow.test.ts test/publish.test.ts
pnpm --filter @playground/web exec node test/review.mjs
pnpm -r typecheck
```

Ports 8791, 8793, 8794, 4318, and 4320 must be free. The tests do not load `.env.local` or `.dev.vars`; their fixture Worker configuration contains no real credentials. No deploy or live inference is part of this validation.

Coverage includes read-only snapshots, two watcher tabs, relay restart/reconnect, warm denial, idle checkpoint/destruction followed by approval, failed cold startup and retry, duplicate/conflicting decisions, stale messages, GitHub commit reconciliation, and saved-result redelivery.
