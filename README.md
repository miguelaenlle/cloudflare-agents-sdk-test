# Persistent Codex chat

A minimal PrairieLearn-shaped prototype: a React/Vercel AI SDK UI talks through a replaceable Express relay to a Cloudflare `AIChatAgent`. Native **Codex app-server** runs inside a Cloudflare Sandbox and owns the model/tool loop. The browser and webserver can disappear without cancelling work.

[Architecture and diagrams](docs/architecture.md) · [Proposal status](docs/architecture-proposed.md)

```text
Browser: React / AI SDK
  ↕ HTTP commands + AI SDK SSE
PL-style Express relay
  ↕ Cloudflare chat WebSocket + HTTP controls
Chat Durable Object: history, coordinator, protocol/event adapter
  ↕ Private app-server WebSocket via Cloudflare Sandbox SDK
Sandbox: persistent native Codex app-server + workspace
  ↕ HTTPS Responses through outbound credential injection
OpenAI

Workspace + native session → R2 checkpoints
```

## Code map

| File                                   | Responsibility                                                             |
| -------------------------------------- | -------------------------------------------------------------------------- |
| `apps/agent/agent.ts`                  | Chat coordinator, steering/Stop, deadlines, checkpoint and recovery policy |
| `apps/agent/codex.ts`                  | Start/reuse app-server, private connection, restore/backup                 |
| `apps/agent/app-server.ts`             | Small typed JSON-RPC client                                                |
| `apps/agent/codex-events.ts`           | Native notifications → AI SDK text/tool events                             |
| `apps/agent/sandbox.ts`, `outbound.ts` | Network allowlist and OpenAI credential injection                          |
| `apps/agent/protocol.ts`               | Generated types from pinned Codex 0.155.0; do not hand-edit                |
| `apps/web/`                            | Barebones UI, stateless relay, replaceable provider adapter                |
| `packages/chat-contract/`              | Provider-independent routes, types, steering validation                    |

The per-turn runner and Codex TypeScript SDK are removed. Prompts/steering/interrupts use app-server RPC; chat delivery no longer parses stdout. Process logs are diagnostic only.

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

Wrangler builds/uploads the container and deploys the Worker. The existing `Chat` and `Sandbox` SQLite migrations are preserved. The Sandbox class and `ContainerProxy` export enable outbound interception. No website is hosted by this Worker. Earlier Workers AI chat history remains visible, but it is not imported into the new native Codex thread.

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

1. Ask **Create hello.txt containing a greeting, then print it with a shell command.** Verify streamed text and tool output.
2. Ask **What did you put in hello.txt?** The same sandbox process and native thread should be reused.
3. Click **Run one-minute task**. After work starts, restart the local backend or close the browser. Reconnect to see the saved/live result.
4. During a turn, enter a correction and click **Steer current turn**. It adds input to that native turn; it does not restart the process. Reopen history to verify the accepted correction was saved.
5. Click **Stop**. Wait for interruption confirmation; the app-server stays running and the next prompt resumes the thread. Closing the page alone never cancels work.
6. Wait ten minutes in `waiting_for_user`, then send another prompt. Confirm destruction and restoration of both `hello.txt` and native context from R2.
7. Verify the sliding six-hour user-interaction deadline. An accepted prompt/steer/active-turn Stop resets it; model/tool output and reconnects do not. There is no absolute sandbox-age cap.

Live acceptance must verify outbound HTTPS interception/TLS trust, private socket authentication, Codex `workspace-write` tool execution, and real R2 restoration. No cloud deployment or paid inference has been run by the implementation tests. Use Worker logs for diagnostics:

```sh
pnpm --filter @playground/agent exec wrangler tail --config wrangler.jsonc
```

## Behavior and limits

- **One app-server per warm sandbox.** `turn/completed` ends a turn; it does not exit the process. Close the control socket between turns and reconnect/initialize/resume on the next prompt.
- **Persistence:** UI history/replay and coordination are in Chat DO SQLite. `/workspace/repo` and `/workspace/codex` are backed up after terminal turns and before idle destruction. Only the last successful checkpoint survives unexpected loss.
- **Lifecycle:** `keepAlive: false`, CF `sleepAfter: "6h"`, ten minutes waiting-state cleanup, and a separate durable six-hour deadline since user input. An open proxied WebSocket prevents CF idle expiry; the application deadline still bounds active work.
- **Uncertain execution:** reconnect and inspect/interrupt surviving native work before accepting another turn. Never automatically replay a prompt. Missing tool events may become a terminal recovery message rather than a complete event replay.
- **Stop:** RPC acknowledgment is insufficient; wait for a terminal notification. Unconfirmed Stop blocks another turn; deadline cleanup can eventually destroy the box.
- **Cleanup:** at most three automatic attempts, 30 seconds apart. Failed destruction retains the sandbox identity and blocks replacement; a later prompt can explicitly retry.
- **History and backups are not atomic.** Restoring files may roll back work still described in UI history. Backup cadence remains conservative pending measurement.
- **Trusted prototype only:** one shared conversation, no authentication or approval UI. Origin checks are not authorization. Multi-window synchronization remains a gap.

## Credentials and network

`CODEX_API_KEY` stays a Worker secret. The Sandbox outbound handler injects it only into HTTPS POSTs to OpenAI Responses/compaction. It rejects redirects and overwrites caller authorization. Codex is configured for HTTP Responses without local authentication or model WebSockets.

The container also permits the configured R2 account host for SDK presigned backup transfers. Other internet hosts—including Git/package registries—are blocked until explicitly allowed. The permanent R2 keys also stay in Workers; presigned URLs are short-lived scoped capabilities available during transfers.

The private app-server socket has its own capability token in `/tmp`, separate from the OpenAI key. No OpenAI credential is passed in the container environment, auth file, or prompt; no runner redaction remains. Prompts, files, and native sessions can still contain unrelated sensitive information. Legacy credential paths remain excluded from backups; existing backups are not retroactively cleaned.

On upgrade from the old runner, stop old work first; the runtime does not migrate an actively executing runner into an app-server turn.

## Web interface

| Endpoint                          | Behavior                                          |
| --------------------------------- | ------------------------------------------------- |
| `POST /api/chat`                  | Submit messages; AI SDK UI Message Stream SSE     |
| `GET /api/chat/history`           | Saved `UIMessage[]`                               |
| `GET /api/chat/playground/stream` | Replay/attach to current output, or 204           |
| `POST /api/chat/cancel`           | Explicit interruption                             |
| `POST /api/chat/steer`            | `{ id, runId, text }`; steer only that active run |

Replacing Cloudflare changes the provider adapter and agent deployment; these browser routes/events can stay. Persistent data needs migration.

## Local checks

```sh
pnpm typecheck
pnpm build
pnpm test
pnpm --filter @playground/agent test:native
pnpm format:check
```

`pnpm test` uses real AIChatAgent/Worker and relay code against a simulated sandbox. It covers reconnection, detached completion, native-process reuse, steering persistence, Stop, lost start acknowledgment, restore, stale alarms, sliding deadlines, and cleanup failures. `test:native` runs the pinned native app-server with a fake local Responses endpoint; it needs no API key, Docker, or paid inference.

Regenerate protocol types after intentionally updating the Codex pin:

```sh
pnpm --filter @playground/agent generate:protocol
```

To check Worker bundling without building/deploying a container:

```sh
pnpm --filter @playground/agent exec wrangler deploy --config wrangler.jsonc --dry-run --containers-rollout=none --outdir dist
```

`pnpm build:worker` also builds the container and requires Docker. Neither dry-run command deploys. Local tests do not prove the full Cloudflare/R2 integration; complete the acceptance steps above before relying on it.
