# Sandbox lifecycle and recovery

This is layer 2 of a new behavior-oriented review stack. The original five-PR stack and `codex/prototype` are unchanged. Each branch contains a runnable application and its applicable tests.

## Local inference

Use Node 22.18+ and pnpm 11. Install with `pnpm install --frozen-lockfile`. Run Docker. Create ignored `apps/agent/.dev.vars` with `CODEX_API_KEY=your-key`. The trusted outbound handler injects the key; do not put it in the container. Create ignored root `.env.local` with `AGENT_URL=http://localhost:8790`.

Run `pnpm dev:agent`, `pnpm dev:server`, and `pnpm dev` in separate terminals. Open http://localhost:4315. Each checkout has its own Wrangler state. Avoid running two checkouts on the same ports. Production requires a matching `RELAY_TOKEN` in the Worker and relay environment; `LOCAL_DEV` bypasses it only in the local command.

Run `pnpm typecheck`, `pnpm build`, and `pnpm test` for this layer. The tests use a local Worker/DO with a simulated sandbox and a relay on ports 8791/4318; they make no paid model calls.

## Lifecycle

After ten minutes waiting for the user, back up before destroying. After six hours without accepted user interaction, attempt a bounded final backup and destroy. Restore the workspace/native thread on the next prompt. Diagnostics show state and countdowns. Unexpected loss can lose work since the last backup. Basic Stop is hardened with reconciliation and durable cleanup in this layer. Test idle restoration by creating a file, waiting ten minutes, then reading it in the next turn.
