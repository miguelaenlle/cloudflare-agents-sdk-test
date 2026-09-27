# Minimal host-executed tool

This branch targets PR #16. It demonstrates live execution through the existing relay watch WebSocket; it does not include PR #17's approvals or PR #18's publication workflow.

```text
Codex item/tool/call → Chat DO → host-tool-call → PL relay handler
Codex tool response ← Chat DO ← host-tool-result ← handler output
```

## Review order

1. `apps/web/server/host-tools.ts`: the actual host_echo implementation. It validates input and returns `{ text, executedBy: "pl-relay" }`.
2. `apps/web/server/providers/cloudflare.ts`: the existing watch socket handles explicit tool frames alongside SDK state notifications. Snapshot reads have no tool-execution side effects.
3. `apps/agent/host-tools.ts`: select one executor, correlate its reply, and bound the live wait to 30 seconds.
4. `apps/agent/agent.ts`: mark authenticated relay watchers as executors and route custom messages without replacing SDK chat handling.
5. `apps/agent/app-server.ts` and `codex-turn.ts`: register the definition and return the result to the matching native turn. The existing tool UI displays the result.

## Local demo with real inference

Use this checkout and create a new conversation; previously created native threads do not gain new tool definitions.

```sh
cd /Users/miguel/PrairieLearn/repos/cloudflare-agents-sdk-test-host-tool
pnpm install --frozen-lockfile
```

Have Docker and PostgreSQL running. Put your OpenAI key in `apps/agent/.dev.vars` as `CODEX_API_KEY=...`. Create `.env.local` with `AGENT_URL=http://localhost:8790` and `DATABASE_URL` pointing at your separate prototype Postgres database. The relay creates its schema. This demo adds no tables and needs no GitHub token.

Run these in three terminals from this checkout (stop other services using the same ports first):

```sh
pnpm dev:agent
```

```sh
pnpm dev:server
```

```sh
pnpm dev
```

Open http://localhost:4315 and create a new conversation. Ask:

> Call host_echo with the text "hello from Codex" and tell me what executedBy says.

Expand Tool activity: its output contains `executedBy: "pl-relay"`. The relay terminal prints one execution with the correlation ID. Open a second tab on the same conversation and call it again: only one watcher executes the call.

For manual Cloudflare testing, deploy this branch with the existing production Worker settings/secrets, point this checkout's relay at that Worker, and create a new conversation. Keep Worker and relay on the same branch. Nothing in this PR deploys automatically.

## Failure semantics

- The Worker authenticates relay requests using the existing RELAY_TOKEN. Only a server-side watch connection with the executor header and no browser Origin is eligible. Local development keeps the existing LOCAL_DEV authentication bypass.
- Every call is sent to one eligible socket. The result must match both its call ID and that socket. Another tab cannot complete it.
- Missing executors, disconnect and timeout return explicit failures. No automatic replay or failover occurs: an external effect could already have happened.
- Stop invalidates pending replies. It cannot undo or forcibly cancel host-side effects. Native completion also clears outstanding waits.
- Pending calls exist only in memory. DO/process loss follows the existing interrupted-turn recovery path; this PR does not resume approvals or promise exactly-once effects.
- The executor connection is browser-scoped, just like the existing watch connection. With every tab closed, no background host executor remains. The harmless echo handler makes these tradeoffs easy to inspect before adding durable tools.

## Automated checks

```sh
pnpm --filter @playground/agent test
pnpm --filter @playground/web exec node --experimental-strip-types --test test/host-tools.test.ts
```

The second command uses port 8793 and temporary Worker storage. It runs the actual Chat DO and relay provider with two watch sockets, injects a native protocol call from the simulated sandbox, checks its reply, and verifies the tool result persists in chat history. It requires no API key, Docker, Postgres, or deployment. Unit tests cover timeout, disconnect, Stop, mismatched/late results, and safe handler failures. The automated sandbox is a fixture, not real Codex inference.
