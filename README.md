# Persistent Codex chat

A minimal PrairieLearn-shaped prototype: a React/Vercel AI SDK UI talks through a replaceable Express relay to a Cloudflare `AIChatAgent`. Native **Codex app-server** runs inside a Cloudflare Sandbox and owns the model/tool loop. The browser and webserver can disappear without cancelling work.

[Local testing and manual deployment](docs/testing.md) · [Architecture and diagrams](docs/architecture.md) · [Proposal status](docs/architecture-proposed.md) · [Conversations, steering, Git and approvals](docs/conversations-and-approvals.md)

```text
Browser: React / AI SDK
  ↕ HTTP commands + AI SDK SSE
PL-style Express relay
  ↕ Cloudflare chat WebSocket + HTTP controls
Chat Durable Object: history, coordinator, protocol/event adapter
  ↕ Private app-server WebSocket via Cloudflare Sandbox SDK
Sandbox: persistent native Codex app-server + workspace
  ↕ HTTP to private handler → authenticated HTTPS to OpenAI
OpenAI

Workspace + native session → R2 checkpoints
```

## Code map

| File                                   | Responsibility                                                             |
| -------------------------------------- | -------------------------------------------------------------------------- |
| `apps/agent/worker.ts`                 | Public routing, origin checks, deployment exports                          |
| `apps/agent/codex-turn.ts`             | Native thread/turn startup, subscriptions, output conversion               |
| `apps/agent/agent.ts`                  | Chat coordinator, steering/Stop, deadlines, checkpoint and recovery policy |
| `apps/agent/codex.ts`                  | Start/reuse app-server, private connection, restore/backup                 |
| `apps/agent/app-server.ts`             | Small typed JSON-RPC client                                                |
| `apps/agent/codex-events.ts`           | Native notifications → AI SDK text/reasoning/tool/steering events          |
| `apps/agent/sandbox.ts`, `outbound.ts` | Network allowlist and OpenAI/GitHub credential injection                   |
| `apps/agent/protocol.ts`               | Generated types from pinned Codex 0.155.0; do not hand-edit                |
| `apps/web/`                            | Barebones UI, relay with durable decision outbox, provider adapter         |
| `packages/chat-contract/`              | Provider-independent routes, types, message validation                     |

The per-turn runner and Codex TypeScript SDK are removed. Prompts/steering/interrupts use app-server RPC; chat delivery no longer parses stdout. Process logs are diagnostic only.

## Real local development

Start Docker, put `CODEX_API_KEY=...` in ignored `apps/agent/.dev.vars`, then run `pnpm dev:agent`, `pnpm dev:server:local`, and `pnpm dev` in separate terminals. Open http://localhost:4315. This executes real prompts with local Worker/DOs, a real Docker sandbox, and Wrangler's local R2 storage; only inference uses the cloud.

See [local development and reset instructions](docs/testing.md#real-local-development-actual-prompts). No R2 secrets or Cloudflare deployment are needed for this path. Do not set `LOCAL_DEV` in production.

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
pnpm --filter @playground/agent exec wrangler secret put RELAY_TOKEN --config wrangler.jsonc
pnpm --filter @playground/agent exec wrangler secret put CODEX_API_KEY --config wrangler.jsonc
pnpm --filter @playground/agent exec wrangler secret put R2_ACCESS_KEY_ID --config wrangler.jsonc
pnpm --filter @playground/agent exec wrangler secret put R2_SECRET_ACCESS_KEY --config wrangler.jsonc
pnpm deploy
```

Wrangler builds/uploads the container and deploys the Worker. The existing `Chat` and `Sandbox` SQLite migrations are preserved. The Sandbox class and `ContainerProxy` export enable outbound interception. No website is hosted by this Worker. Earlier Workers AI chat history remains visible, but it is not imported into the new native Codex thread.

Backups expire after **30 days**. Configure an R2 lifecycle rule on `backups/` to delete objects older than 31 days; the SDK's expiry does not delete the objects. This is a prototype retention policy, not permanent storage. An expired backup causes an explicit restore error.

Set the root `.env.local` (use `.env.example` as a template):

```dotenv
AGENT_URL=https://cloudflare-agents-sdk-test.YOUR_SUBDOMAIN.workers.dev
RELAY_TOKEN=the-same-random-secret-set-on-the-worker
```

Run the local backend and frontend in separate terminals:

```sh
pnpm dev:server
```

```sh
pnpm dev
```

Open **http://localhost:4315**. Restart the backend after changing `.env.local`.

## Approval-gated Git pushes

The private [test repository](https://github.com/miguelaenlle/course-agent-push-sync-test) starts empty. Approved changes are pushed by the PL relay with the shared repository-scoped read/write PAT; Course Sync remains simulated. Follow [PAT setup and the empty-repository test](docs/push-sync-testing.md).

## Try it

1. Ask **Create hello.txt containing a greeting, then print it with a shell command.** Verify streamed text and tool output.
2. Ask **What did you put in hello.txt?** The same sandbox process and native thread should be reused.
3. Ask **Run a shell command that waits 60 seconds, then report the result.** After work starts, restart the local backend or close the browser. Reconnect to see the saved/live result.
4. During a turn, enter a correction and click **Send** again. The DO steers the active turn, or starts a new turn if it just finished. No run ID or separate steering action is required. Verify the correction in history.
5. Click **Stop**. Wait for interruption confirmation; the app-server stays running and the next prompt resumes the thread. Closing the page alone never cancels work.
6. Wait ten minutes after turn completion for idle cleanup, then send another prompt. Confirm destruction and restoration of both `hello.txt` and native context from R2.
7. Verify the sliding six-hour user-interaction deadline. An accepted prompt/steer/active-turn Stop resets it; model/tool output and reconnects do not. There is no absolute sandbox-age cap.

Live acceptance must verify outbound credential injection and upstream HTTPS, private socket authentication, Codex `externalSandbox` tool execution, and real R2 restoration. The automated tests use a fake model. Native commands with `externalSandbox` were verified in a local Docker smoke test; the container is the isolation boundary. No cloud deployment has been performed. Use Worker logs for diagnostics:

```sh
pnpm --filter @playground/agent exec wrangler tail --config wrangler.jsonc
```

## Behavior and limits

- **One app-server per warm sandbox.** `turn/completed` ends a turn; it does not exit the process. Close the control socket between turns and reconnect/initialize/resume on the next prompt.
- **Persistence:** UI history/replay and coordination are in Chat DO SQLite. `/workspace/repo` and `/workspace/codex` are backed up only immediately before planned destruction. Completion, steering, Stop, and recovery retain the warm workspace without a backup. Unexpected loss restores the last successful checkpoint; before the first backup it starts a fresh workspace.
- **Lifecycle:** `keepAlive: false`, CF `sleepAfter: "6h"`, ten minutes waiting-state cleanup, and a separate durable six-hour deadline since user input. An open proxied WebSocket prevents CF idle expiry; the application deadline still bounds active work.
- **Uncertain execution:** reconnect and inspect/interrupt surviving native work before accepting another turn. Never automatically replay a prompt. Missing tool events may become a terminal recovery message rather than a complete event replay.
- **Stop:** RPC acknowledgment is insufficient; wait for a terminal notification. Unconfirmed Stop blocks another turn; deadline cleanup can eventually destroy the box.
- **Cleanup:** at most three automatic attempts, 30 seconds apart. Failed destruction retains the sandbox identity and blocks replacement; a later prompt can explicitly retry.
- **History and backups are not atomic.** Restoring files may roll back work still described in UI history. Unexpected loss may discard all work since the last planned shutdown, even though its chat history remains.
- **Trusted single-user prototype:** multiple conversations, revision-checked sends, durable approval UI. Production Worker access requires `RELAY_TOKEN`; the localhost relay still needs PrairieLearn user/course authorization before integration.

## Credentials and network

`CODEX_API_KEY` stays a Worker secret. The Sandbox outbound handler accepts private HTTP requests at `openai.internal` and injects it only into HTTPS POSTs to the fixed OpenAI Responses/compaction endpoints. It rejects redirects and overwrites caller authorization. Codex is configured for HTTP Responses without local authentication or model WebSockets.

In production, the container also permits the configured R2 account host for SDK presigned backup transfers. Other internet hosts—including direct OpenAI access and package registries—are blocked. GitHub permits only read-only Git endpoints for `GITHUB_REPOSITORY`. The permanent R2 keys also stay in Workers; presigned URLs are short-lived scoped capabilities available during transfers.

The private app-server socket has its own capability token in `/tmp`, separate from the OpenAI key. No OpenAI credential is passed in the container environment, auth file, or prompt; no runner redaction remains. Prompts, files, and native sessions can still contain unrelated sensitive information. Files named `auth.json` remain excluded from backups; existing backups are not retroactively cleaned.

On upgrade from the old runner, stop old work first; the runtime does not migrate an actively executing runner into an app-server turn.

## Web interface

| Endpoint                          | Behavior                                                             |
| --------------------------------- | -------------------------------------------------------------------- |
| `POST /api/chat`                  | `{ id, text, expectedRevision }`; start or steer; 204 acknowledgment |
| `GET /api/chat/history`           | Saved `UIMessage[]`                                                  |
| `GET /api/chat/playground/stream` | Replay/attach to current output, or 204                              |
| `POST /api/chat/cancel`           | Explicit interruption                                                |

Send submits one message through HTTP; output is attached separately through the existing AI SDK resume stream. The UI detaches its previous subscription, sends, reloads history, and reattaches. Detaching never stops Codex. This deliberately replays output on each Send instead of maintaining two competing streams or a separate steering transcript.

The DO serializes message/Stop commands and chooses start versus steer from authoritative state. A confirmed RPC rejection after the turn ends falls back to a new turn. A timeout or lost acknowledgment never does: acceptance may already have happened. Retrying an already persisted message ID does not execute it again; uncertain, unpersisted steering still requires checking history/native state before a manual retry.

Replacing Cloudflare changes the provider adapter and agent deployment; these browser routes/events can stay. Persistent data needs migration.

## Local checks

```sh
pnpm typecheck
pnpm build
pnpm test
pnpm --filter @playground/agent test:native
pnpm format:check
```

`pnpm test` uses real AIChatAgent/Worker and relay code against a simulated sandbox. It covers reconnection, detached completion, native-process reuse, unified send, steering persistence, completion-race fallback, lost steering acknowledgment without replay, Stop, no backups during warm execution, pre-destruction backup ordering, idle/deadline backup failures, lost start acknowledgment, restore, stale alarms, sliding deadlines, and cleanup failures. `test:native` runs the pinned native app-server with a fake local Responses endpoint; it needs no API key, Docker, or paid inference.

Regenerate protocol types after intentionally updating the Codex pin:

```sh
pnpm --filter @playground/agent generate:protocol
```

To check Worker bundling without building/deploying a container:

```sh
pnpm --filter @playground/agent exec wrangler deploy --config wrangler.jsonc --dry-run --containers-rollout=none --outdir dist
```

`pnpm build:worker` also builds the container and requires Docker. Neither dry-run command deploys. Local tests do not prove the full Cloudflare/R2 integration; complete the acceptance steps above before relying on it.
