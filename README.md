# Persistent Codex chat through a local relay

A minimal PrairieLearn-shaped prototype: the official TypeScript Codex SDK runs native Codex inside a Cloudflare Sandbox; an `AIChatAgent` owns the durable chat. The local webserver can disappear without stopping a turn. No PrairieLearn application files are changed.

```text
React / AI SDK useChat on localhost:4315
  ↕ HTTP commands + AI SDK message-stream SSE
Local Express relay on 127.0.0.1:4316
  ↕ Cloudflare WebSocket / HTTP adapter
Cloudflare Chat("playground") / AIChatAgent
  ↕ Sandbox SDK
Cloudflare Sandbox: official Codex SDK → local Codex + workspace
  ↕ OpenAI model inference

Completed workspace + native Codex session → R2 checkpoint
```

The browser and relay have the same provider-independent interface as before. Codex owns its tool loop, commands, edits, and native conversation. There is no OpenAI Agents API or custom agent loop. Chat text is emitted when Codex completes a message item, not token by token.

## Code map

- `apps/agent/agent.ts`: coordinates turns, cancellation, durable cleanup, and UI history through `AIChatAgent`.
- `apps/agent/codex.ts`: starts/observes/stops Codex and saves/restores the sandbox.
- `apps/agent/codex-events.ts`: converts streamed SDK events into standard AI SDK text and tool events.
- `apps/agent/run-codex.mjs`: small container runner; calls `startThread` / `resumeThread` and `runStreamed`, redacts and streams events, and handles cancellation/deadlines.
- `apps/agent/Dockerfile`: pins Sandbox **0.12.9** and Codex SDK **0.155.0** (which installs its matching native CLI). No credentials in the image.
- `apps/web/client/`: barebones React UI with standard `useChat` and `DefaultChatTransport`.
- `apps/web/server/`: stateless Express HTTP/SSE relay and the Cloudflare-specific adapter.
- `packages/chat-contract/`: shared routes, request validation, and provider interface. No Cloudflare dependency.

To replace Cloudflare, change the server's provider adapter and deployed agent. The frontend event format and HTTP interface can stay; stored history still needs migration.

## Cloudflare setup — you perform these steps

Prerequisites: Node **22.18+**, pnpm **11**, Docker running, Cloudflare Workers Paid/Containers access, and R2. You also need an OpenAI API key with access to the model you intend to use. Container compute, R2, and OpenAI inference incur their respective usage charges.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @playground/agent exec wrangler login
pnpm --filter @playground/agent exec wrangler r2 bucket create codex-playground-backups
```

Edit `apps/agent/wrangler.jsonc`:

- Replace `vars.CLOUDFLARE_ACCOUNT_ID` with your actual account ID. This is also used by the Sandbox backup API.
- If you change the bucket name, update both `BACKUP_BUCKET_NAME` and `r2_buckets[].bucket_name`.
- Optionally add `CODEX_MODEL` to `vars` to select your model. Otherwise the pinned CLI chooses its default.

Create an R2 API token with **Object Read & Write** scoped to this bucket. Store its access-key pair and your OpenAI API key as Worker secrets:

```sh
pnpm --filter @playground/agent exec wrangler secret put CODEX_API_KEY --config wrangler.jsonc
pnpm --filter @playground/agent exec wrangler secret put R2_ACCESS_KEY_ID --config wrangler.jsonc
pnpm --filter @playground/agent exec wrangler secret put R2_SECRET_ACCESS_KEY --config wrangler.jsonc
pnpm deploy
```

Wrangler builds/uploads the container and deploys the Worker. The original `Chat` SQLite migration is preserved; `v2` adds `Sandbox`. No website is hosted by this Worker. Earlier Workers AI chat history remains visible, but it is not imported into the new native Codex thread.

Backups expire after **30 days**. Configure an R2 lifecycle rule on `backups/` to delete objects older than 31 days; the SDK's expiry does not delete the objects. This is a prototype retention policy, not permanent storage. An expired backup causes an explicit restore error.

Set the root `.env.local` (use `.env.example` as a template):

```dotenv
AGENT_URL=https://cloudflare-agents-sdk-test.YOUR_SUBDOMAIN.workers.dev
```

Run the local backend and frontend in separate terminals:

```sh
pnpm dev:server
```

```sh
pnpm dev
```

Open **http://localhost:4315**. Restart the backend after changing `.env.local`.

## Try it

1. Ask: **Create hello.txt containing a short greeting and run a command to print it.** Verify tool activity and the reply.
2. Ask: **What did you put in hello.txt? Read it again.** This must resume the same native Codex thread.
3. Click **Run one-minute task**. After command activity appears, stop the local backend and close the page. Restart it after a minute; the completed answer should be in history. Repeat with a restart during the turn to test stream replay.
4. Click **Stop** during a task. It must stop the sandbox process; closing the page alone must not.
5. Leave the conversation in `waiting_for_user` for ten minutes and confirm the sandbox is destroyed in Cloudflare. Ask it to read `hello.txt` again: a new sandbox should restore both workspace and native session from R2. History reads and browser reconnections must not extend the waiting deadline.
6. Verify the six-hour sandbox lifetime deadline destroys the sandbox even during a turn. A later message should restore the last successful checkpoint without replaying the interrupted prompt.

The live container checks are still necessary. In particular, verify that Codex's `workspace-write` sandbox works inside Cloudflare's runtime. The implementation never silently disables it. Inspect Worker logs with:

```sh
pnpm --filter @playground/agent exec wrangler tail --config wrangler.jsonc
```

SDK events travel over stdout through Cloudflare's buffered process-log stream. Non-secret input, cancellation markers, thread IDs, and final outcomes live under `/tmp/codex-runs/<run-id>/`, outside checkpoints. The runner determines the Codex outcome; the Worker handles infrastructure interruptions. SDK failures are reported in the chat; inspect the Sandbox process logs for runner startup failures.

## Persistence and limits

- `AIChatAgent` persists the UI transcript. Codex's native session lives in `/workspace/codex`; the working Git repository is `/workspace/repo`.
- A turn gets a durable run ID before launch. The launcher atomically claims that ID. A Chat Durable Object restart stops any surviving process and saves an interruption message. It never automatically repeats the prompt or reattaches to the old execution.
- The Worker consumes Cloudflare’s process-log SSE stream, including buffered output from before attachment. There is no observation polling loop or container HTTP service. A disconnected process stream reports failure; it never replays the prompt.
- Sandbox state follows `offline → starting → waiting_for_agent → waiting_for_user`. Keep-alive remains enabled between turns. A durable callback transitions `waiting_for_user → suspending → offline` after ten minutes, making a fresh checkpoint before destroying the sandbox. An active turn or a different waiting period invalidates an old idle callback. History reads do not wake the container or extend this deadline.
- **Stop** writes a cancellation marker watched by the runner, which aborts `runStreamed` through the SDK. The coordinator waits up to five seconds for exit; it never force-kills merely because that wait expires. An unconfirmed stop reports an error and keeps the run active, keep-alive enabled, and new turns blocked. This ends the current turn; the next prompt resumes the native thread.
- There is no ten-minute turn limit. Each sandbox generation has an absolute six-hour deadline, measured from allocation before startup and unchanged by later turns. The runner and process timeout use the remaining lifetime. The Chat DO schedules destruction at that same deadline and aborts its observer; it does not wait for graceful stop or a new backup. Work since the last checkpoint can be lost. Each new sandbox gets a new ID so stale callbacks cannot destroy its replacement.
- Cleanup makes at most three attempts, 30 seconds apart. Idle backup failure keeps the workspace for another attempt or user message. Hard-expiry destruction failure records `cleanup_failed`, attempts to disable keep-alive, and does not silently provision another box. A later user message can explicitly retry destruction before restoring. The underlying `sleepAfter: "6h"` is a fallback idle timeout, not the absolute cap. Cloudflare API outages can delay actual destruction; a deadline is not a platform guarantee.
- A turn-end checkpoint failure is reported while the sandbox remains warm. Idle suspension retries backup before destruction; the hard six-hour cap still takes precedence. Only the last successful checkpoint is guaranteed to survive container loss.
- A container crash during a turn may lose work since the last checkpoint. The UI reports interruption rather than claiming exactly-once execution.
- One shared conversation, one sandbox, no authentication or approval UI. This is for a trusted disposable workspace. The runtime API-key environment variable is readable by code inside the container; do not use this prototype for untrusted course code or expose it publicly as a production service.
- A passive second tab needs **Reconnect / refresh history** to see a turn started elsewhere.

## Credentials and saved output

`CODEX_API_KEY` is injected into the runner environment, then passed to the official SDK. Codex uses memory-only credential storage (`cli_auth_credentials_store = "ephemeral"`). The native process receives only a small environment allowlist; shell tools inherit no environment and get only `PATH` and `HOME` explicitly.

The runner redacts the exact injected key from structured event strings and final errors before writing stdout/results. The coordinator also redacts that key from errors it reports or logs. Run artifacts and Codex diagnostic file logs are under `/tmp`. Checkpoints retain `/workspace/repo` and native session state in `/workspace/codex`; they exclude `codex/auth.json`, legacy `codex/log`, and legacy `runs` directories as defense in depth.

This is not a guarantee that all stored data is secret-free. Native Codex session files are written before our event adapter and may contain sensitive prompts or tool output. Files deliberately written to the repository are also backed up. Environment filtering is not isolation from code that can inspect other processes. Exact-key redaction does not cover encoded keys or unrelated secrets. R2's encryption at rest does not hide content from authorized backup readers, and these changes do not scrub existing backups. Treat native sessions and backups as sensitive data.

## Stable web interface

| Endpoint                          | Behavior                                          |
| --------------------------------- | ------------------------------------------------- |
| `GET /api/chat/history`           | Saved AI SDK `UIMessage[]`                        |
| `POST /api/chat`                  | Send a message; receive UI Message Stream SSE     |
| `GET /api/chat/playground/stream` | Replay/attach to the current turn, or 204 if idle |
| `POST /api/chat/cancel`           | Explicitly stop the active work                   |

## Local checks

```sh
pnpm typecheck
pnpm build
pnpm format:check
pnpm test
```

Tests require neither credentials nor Docker. They run the real chat coordinator against a deterministic Sandbox substitute, plus native subprocess tests with a fake Codex executable. They cover JSONL chunking, tool mapping, duplicate launch prevention, SDK subprocess cancellation, confirmed Sandbox stop, relay replacement, saved history, cancellation, cold restoration, Worker restart interruption without replay, checkpoint failure followed by warm resume, ten-minute waiting-state destruction, stale callbacks, active work beyond ten minutes, absolute six-hour expiry, restoration after destruction, and bounded cleanup failures.

`pnpm build:worker` is a deployment dry run that also needs Docker to build the image. To check just Worker bundling without Docker:

```sh
pnpm --filter @playground/agent exec wrangler deploy --config wrangler.jsonc --dry-run --containers-rollout=none --outdir dist
```

No cloud deployment or paid inference is part of these local tests. A passing fixture test is not proof of Cloudflare container compatibility or a real R2 restore.

References: [Codex SDK](https://developers.openai.com/codex/sdk/), [Sandbox processes](https://developers.cloudflare.com/sandbox/guides/background-processes/), [Sandbox backups and R2 setup](https://developers.cloudflare.com/sandbox/guides/backup-restore/).
