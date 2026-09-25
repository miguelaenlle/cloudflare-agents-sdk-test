# Minimal working Codex chat

This is layer 1 of a new behavior-oriented review stack. The original five-PR stack and `codex/prototype` are unchanged. Each branch contains a runnable application and its applicable tests.

## Local inference

Use Node 22.18+ and pnpm 11. Install with `pnpm install --frozen-lockfile`. Run Docker. Create ignored `apps/agent/.dev.vars` with `CODEX_API_KEY=your-key`. The trusted outbound handler injects the key; do not put it in the container. Create ignored root `.env.local` with `AGENT_URL=http://localhost:8790`.

Run `pnpm dev:agent`, `pnpm dev:server`, and `pnpm dev` in separate terminals. Open http://localhost:4315. Each checkout has its own Wrangler state. Avoid running two checkouts on the same ports. Production requires a matching `RELAY_TOKEN` in the Worker and relay environment; `LOCAL_DEV` bypasses it only in the local command.

Run `pnpm typecheck`, `pnpm build`, and `pnpm test` for this layer. The tests use a local Worker/DO with a simulated sandbox and a relay on ports 8791/4318; they make no paid model calls.

## Scope and limitations

One persistent conversation, native Codex text/tool output and independently reconnectable HTTP/SSE subscribers. Additional sends during a running turn are rejected. Stop can interrupt a live native turn. An uncertain submission is never replayed automatically. A lost process/DO can leave the conversation blocked; use fresh development state until the next lifecycle layer adds reconciliation. SDK idle shutdown can lose workspace files: this layer has no backup/restore or application deadlines yet. This is a foundation for local review, not the cloud acceptance release.
