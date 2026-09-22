# Chat prototype: web interface and provider boundary

This first stack layer contains the React UI, stateless Express relay, shared chat contract, and workspace setup. Later layers add the Codex protocol client, Cloudflare sandbox, Chat Durable Object, integration tests, and full architecture/setup docs.

## Review focus

- `packages/chat-contract/src/index.ts`: history, send, resume, Stop, and steering contract.
- `apps/web/server/server.ts`: HTTP routes and AI SDK SSE responses.
- `apps/web/server/providers/cloudflare.ts`: the replaceable Cloudflare adapter.
- `apps/web/client/app.tsx`: standard AI SDK chat UI with history/reconnect and controls.

The frontend and relay contain no durable execution state. They expect a compatible deployed agent; this layer does not include that deployment. Agent dependencies are declared up front so the stack shares one pinned lockfile.

## Local checks

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```
