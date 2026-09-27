# Durable approvals with simulated publication

This is layer 5 of a new behavior-oriented review stack. The original five-PR stack and `codex/prototype` are unchanged. Each branch contains a runnable application and its applicable tests.

Create a dedicated local Postgres database with `createdb course_agent`, and set `DATABASE_URL=postgresql://localhost/course_agent` on the relay.

## Local inference

Use Node 22.18+ and pnpm 11. Install with `pnpm install --frozen-lockfile`. Run Docker. Create ignored `apps/agent/.dev.vars` with `CODEX_API_KEY=your-key`. The trusted outbound handler injects the key; do not put it in the container. Create ignored root `.env.local` with `AGENT_URL=http://localhost:8790`.

Run `pnpm dev:agent`, `pnpm dev:server`, and `pnpm dev` in separate terminals. Open http://localhost:4315. Each checkout has its own Wrangler state. Avoid running two checkouts on the same ports. Production requires a matching `RELAY_TOKEN` in the Worker and relay environment; `LOCAL_DEV` bypasses it only in the local command.

Run `pnpm typecheck`, `pnpm build`, and `pnpm test` for this layer. The tests use a local Worker/DO with a simulated sandbox and a relay on ports 8791/4318; they make no paid model calls.

## Lifecycle

After the configured idle interval (currently 30 seconds for testing) waiting for the user, back up before destroying. After six hours without accepted user interaction, attempt a bounded final backup and destroy. Restore the workspace/native thread on the next prompt. Diagnostics show state and countdowns. Unexpected loss can lose work since the last backup. Basic Stop is hardened with reconciliation and durable cleanup in this layer. Test idle restoration by creating a file, waiting for idle expiration, then reading it in the next turn.

## Conversations and concurrency

The relay stores its catalog, admission revisions and publication decisions in Postgres (`DATABASE_URL`; default `postgresql://localhost/course_agent`). Each conversation routes to its own Chat DO, which retains chat history and lifecycle state. SSE pushes snapshots and diagnostics; stale tabs retain their draft and must refresh. Publication uses GitHub APIs without a relay checkout; incomplete approvals require explicit Retry. See [testing instructions](docs/testing.md) for setup. Production still requires PrairieLearn authorization.

## Steering and richer streaming

Send during execution steers the active native turn. Only confirmed completion permits falling back to a new turn; uncertain acknowledgments are not replayed. Steering markers split live output into segments. Reasoning summaries are rendered separately; these are the model-provided summaries, not hidden reasoning.

## Durable approval

The agent calls `push_sync` with base/proposed commit SHAs. Capture immutable final file contents and a raw diff; the relay persists the proposal and hold the native tool response pending a decision. Ordinary sends are blocked. After idle cleanup, the saved approval remains actionable and its outcome is delivered to a restored continuation. Warm decisions resolve the live tool result. After restart or failure, the user explicitly retries completion from the saved decision card. The layer-5 publisher is explicitly simulated; no GitHub credential is needed and no push occurs.

## Publication

This layer simulates both publication and Course Sync. Layer 6 adds real GitHub API writes while keeping the same saved-decision and explicit-Retry workflow. The full-stack documents describe that next layer as well.
