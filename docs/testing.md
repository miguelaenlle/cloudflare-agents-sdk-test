# Test the complete stack, then deploy manually

Use **`codex/prototype`**, the head of PR #1. It contains all six review layers; checking out PR #5 alone omits the later integration tests and documentation. Commands below run from the repository root unless stated otherwise. Preserve your local `.env.local` and Wrangler settings when updating the checkout.

## 1. Local automated checks

Prerequisites: Node 22.18+ and pnpm 11. These tests need no API key, Docker, R2, or cloud deployment.

```sh
git switch codex/prototype
git pull --ff-only origin codex/prototype
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm --filter @playground/agent test:native
pnpm format:check
```

`pnpm test` starts a local Worker and relay on ports **8791** and **4318**, with temporary storage that it removes afterward. Stop any manual fixture using 8791 first. It exercises real Chat DO/AI SDK persistence against a simulated sandbox. `test:native` separately runs the pinned Codex app-server against a fake local model endpoint.

The integration tests verify:

- Send starts or steers; a completion race starts once; uncertain acknowledgments never replay.
- Relay replacement, detached completion, Stop, and history/stream reconnection.
- Completed turns, steering, Stop, and recovery make **no backup** while retaining the sandbox.
- Idle cleanup backs up before destroying; a failed backup retains the sandbox and retries.
- Deadline cleanup backs up both active and idle sandboxes; backup failure does not prevent deadline destruction.
- Restoration, stale alarms, and bounded destruction retries.

Check the production Worker bundle without deploying or building a container:

```sh
pnpm --filter @playground/agent exec wrangler deploy --config wrangler.jsonc --dry-run --containers-rollout=none --outdir dist
```

## Real local development (actual prompts)

This uses the production Worker, Chat DO, Docker image, native Codex, and local R2. Nothing is deployed. Docker must be running; real prompts use your OpenAI API account. No Cloudflare account or R2 credentials are required for the local backup path.

Create `apps/agent/.dev.vars` (ignored by Git):

```dotenv
CODEX_API_KEY=your-openai-api-key
# Optional: CODEX_MODEL=an-accessible-codex-model
```

Do not copy these values into the Dockerfile or container environment. The local Worker adds authorization when forwarding requests from the private `http://openai.internal` handler to `https://api.openai.com`. This avoids depending on container HTTPS interception; the upstream connection always uses HTTPS, and redirects are rejected.

From the repository root, run three terminals:

```sh
pnpm dev:agent
```

```sh
pnpm dev:server:local
```

```sh
pnpm dev
```

Open **http://localhost:4315**. The Worker listens on **8790**, the relay on **4316**, and the UI on **4315**. The local relay command explicitly selects 8790, ignoring `.env.local`'s deployed URL. Stop an existing relay/UI on those ports before starting these commands. The simulated integration tests continue to use Worker port 8791 and relay port 4318.

`dev:agent` uses the production Wrangler config with `LOCAL_DEV:true` supplied only on its command line. Do not set this flag in production. It selects SDK `localBucket: true` for every shutdown backup; restore reads the mode from the stored handle. Wrangler keeps DO state and emulated R2 in `apps/agent/.wrangler/local`. No separate S3 server or R2 API keys are needed.

**Current local limitation:** on the tested Apple Silicon Docker setup, real model replies work but Codex tool execution fails with `bwrap: pivot_root: Operation not permitted`. Installing distribution Bubblewrap did not resolve it. `workspace-write` remains enabled; do not treat a text-only reply as a successful tool-execution test. A compatible Linux/container environment is still needed to complete this acceptance check.

Try creating a file, reading it on another turn, steering, Stop, and restarting the relay. Then leave the completed conversation idle for ten minutes, observe backup/destruction in the Worker terminal, and ask Codex to read the file after restoration. Backups contain real workspace archives. Local restore extracts them; deployed restore uses an overlay, so keep the deployed acceptance checks below.

Worker edits reload locally. Container/image edits require Wrangler's `r` rebuild or a restart. A Worker restart may interrupt an active turn through our existing reconciliation policy; it never automatically repeats the prompt. Exiting Wrangler stops local containers, so do not expect unsaved workspace files to survive a dev-server restart. Only completed backups survive alongside DO history.

For a clean session, stop the Worker and move its entire local state directory aside (choose an unused destination):

```sh
mv apps/agent/.wrangler/local apps/agent/.wrangler/local.previous
```

Restart `pnpm dev:agent`. Move DO state and backups together; clearing only one leaves mismatched recovery handles. This reset affects local development only. Do not delete a running Docker container to simulate a graceful shutdown: forced deletion cannot create a final backup.

### Verification performed

The local Docker smoke test reached real OpenAI inference, rejected an unauthenticated private WebSocket, blocked unrelated outbound hosts, and confirmed no API-key environment variables or `auth.json` in the container. The ten-minute idle alarm created a real local R2 archive and destroyed the container; a new container restored a manually seeded workspace file.

That restore exposed an SDK 0.12.9 exclusion issue: `codex/auth.json` excluded the entire `codex` directory. The implementation now excludes the basename `auth.json`; a real archive probe verified that the credential file is excluded and sibling session files survive. A second real-container test advanced only the Chat clock to trigger idle cleanup, then verified that a fresh container restored the workspace file and the same native thread, recalled the prior message through real inference, and excluded a dummy `auth.json`. The temporary clock-advance route is not part of the application.

## 2. Local browser smoke test with a simulated sandbox

Use three terminals. The fixture deliberately emits a fixed response and tool event; it does not execute your prompts or create real workspace files.

Terminal 1 — local Worker and persistent test storage:

```sh
pnpm --filter @playground/agent exec wrangler dev --config test/wrangler.jsonc --port 8791 --inspector-port 0
```

Terminal 2 — local PL-style relay, explicitly pointed at the fixture:

```sh
AGENT_URL=http://localhost:8791 pnpm --filter @playground/web exec node --experimental-strip-types server/server.ts
```

Terminal 3 — browser UI:

```sh
pnpm dev
```

Open **http://localhost:4315**. Send a message, send a correction while it runs, then try Stop and another message. Restart the relay during a response and reconnect. Expect persisted history and no duplicated assistant response.

Inspect backup operations in the local fixture:

```sh
curl -s http://localhost:8791/agents/chat/playground/test/backups
```

On fresh local storage, this remains `[]` after turns and Stop. Once the turn has finished, advance the test clock by ten minutes:

```sh
curl -s -X POST http://localhost:8791/agents/chat/playground/test/advance \
  -H 'Content-Type: application/json' -d '{"milliseconds":601000}'
curl -s http://localhost:8791/agents/chat/playground/test/backups
```

Expect `sandbox` to be absent in the first response and the operations `backup`, then `destroy` in the second. Another Send restores the fixture backup. These `/test/*` routes exist only in the local test Worker; **do not deploy `test/wrangler.jsonc`**. Restart the fixture before testing real-time waits after advancing its clock.

## 3. Manual Cloudflare deployment

Stop the local fixture and relay first. Keep the UI local. You need Docker running, a Cloudflare account with Workers Paid/Containers access, an R2 bucket, and an OpenAI API key.

```sh
pnpm --filter @playground/agent exec wrangler login
```

For initial setup, create the bucket if it does not already exist:

```sh
pnpm --filter @playground/agent exec wrangler r2 bucket create codex-playground-backups
```

Check `apps/agent/wrangler.jsonc`:

- `main` must be **`worker.ts`** after this refactor.
- Set `vars.CLOUDFLARE_ACCOUNT_ID` to your account ID.
- Match `vars.BACKUP_BUCKET_NAME` and the `BACKUP_BUCKET` R2 binding to your bucket.
- Keep `UI_ORIGIN` as `http://localhost:4315` for this test.
- Optionally set `CODEX_MODEL`. Keep the existing Chat/Sandbox migration tags and class names.

Create an R2 API token with Object Read & Write scoped to this bucket. Set these secrets if not already configured; the R2 values are its S3 access-key pair:

```sh
pnpm --filter @playground/agent exec wrangler secret put CODEX_API_KEY --config wrangler.jsonc
pnpm --filter @playground/agent exec wrangler secret put R2_ACCESS_KEY_ID --config wrangler.jsonc
pnpm --filter @playground/agent exec wrangler secret put R2_SECRET_ACCESS_KEY --config wrangler.jsonc
pnpm deploy
```

This builds/uploads the container and deploys the Worker. No automated deployment is added. If upgrading a running prototype, finish or stop its active turn before deploying. Backups expire after 30 days; configure the R2 lifecycle rule described in the [README](../README.md).

Set the root `.env.local` to the actual URL printed by Wrangler:

```dotenv
AGENT_URL=https://cloudflare-agents-sdk-test.YOUR_SUBDOMAIN.workers.dev
```

Start `pnpm dev:server` and `pnpm dev` in separate terminals. Start logs in another:

```sh
pnpm --filter @playground/agent exec wrangler tail --config wrangler.jsonc
```

## 4. Live acceptance checks

1. **Native execution:** ask Codex to create `/workspace/repo/review-marker.txt` containing a unique value and print it with a shell command. Verify text and tool results stream. Ask it to read the file on a second turn.
2. **Send/Stop:** use the one-minute task, send a correction during execution, and try Stop. Send another prompt afterward. It should continue the same native conversation.
3. **Ephemeral relay:** restart the local relay or close the browser during a task. Reconnect and verify its result/history. Subscriber disconnection must not act as Stop.
4. **No turn-end backups:** note the bucket's existing objects before testing. Complete several turns and Stop one while keeping idle periods below ten minutes. There should be no new workspace backup from those operations. Existing backups are not deleted by this change.
5. **Idle shutdown and restore:** after completion, send nothing for at least ten minutes plus cleanup time. In the Cloudflare dashboard verify a new backup under `backups/` and container shutdown. Send a prompt asking Codex to read the marker file and recall the previous work. Expect cold-start latency, restored files, and resumed native context.
6. **Deadline behavior:** the six-hour deadline is measured from accepted user interaction, not sandbox creation. To exercise it live, leave a long task with no further Send/Stop actions for six hours and observe cleanup. This is optional for the first smoke test; local clock-controlled tests cover both active and idle cases. Do not add public test-clock routes or change production timers just to accelerate it.

Successful live checks establish the paths that local tests cannot: container startup, private WebSocket authentication, internal HTTP credential injection and upstream OpenAI HTTPS, native tool execution, and real R2 restore. Container/R2 usage and model inference are billed normally.

Backups save files, not a running process. They are attempted only before application-controlled destruction. A platform crash, forced deletion, or failed deadline backup can lose all changes since the previous successful backup; before the first backup, there is nothing to restore. DO chat history remains, but it cannot recreate workspace files. If idle backup fails, the sandbox stays available and cleanup retries; if deadline backup fails, destruction proceeds. Inspect Worker logs if shutdown/restore does not match these expectations.
