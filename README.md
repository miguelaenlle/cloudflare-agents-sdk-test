# Persistent agent chat through a local relay

A minimal prototype of the intended PrairieLearn topology. The local Node server stands in for an ephemeral PL webserver. No PrairieLearn application files are changed.

```text
React on localhost:4315
  AI SDK useChat + DefaultChatTransport
           │ same-origin HTTP / SSE
           ▼
Local Node backend on 127.0.0.1:4316
  /api/chat: AI SDK UI Message Stream
           │ Cloudflare WebSocket / HTTP
           ▼
Cloudflare Chat("playground")
  AIChatAgent + durable SQLite history + Workers AI
```

Vite proxies `/api` to the local backend. The browser has no Cloudflare imports, Worker URL, or Cloudflare connection. There is no custom frontend hook or custom frontend transport.

## Workspace layout

```text
apps/web/
  client/                  React + AI SDK
  server/
    server.ts              HTTP/SSE endpoints
    providers/cloudflare.ts
  test/relay.mjs            End-to-end relay test
  package.json
  tsconfig.json
  vite.config.ts
apps/agent/
  agent.ts                 Cloudflare agent implementation
  test/                    Local deterministic agent fixture
  package.json
  tsconfig.json
  wrangler.jsonc
packages/chat-contract/
  src/index.ts             API paths, request schema, provider interfaces
  package.json
  tsconfig.json
```

The two apps have separate dependencies, builds, and TypeScript environments. The web app imports the contract through `@playground/chat-contract`; it never imports the Worker implementation. The contract uses AI SDK types and Zod and has no Cloudflare dependency. Root scripts forward to the appropriate app, so run all commands below from the repository root. Keep `.env.local` at the root.

The contract exports TypeScript source directly. Vite bundles it for the browser and Node loads it through the local workspace link; it needs no separate build or publication step. The webserver therefore runs from this workspace checkout.

## Who owns what

- `packages/chat-contract/src/index.ts`: shared endpoint names, request validation schema, and the provider interface.
- `apps/web/client/app.tsx`: barebones UI using Vercel AI SDK's `useChat`. Loads history, resumes on mount, retries after stream errors, and sends an explicit Stop request.
- `apps/web/server/server.ts`: local HTTP endpoints and SSE responses. Holds no conversation history or durable run state.
- `apps/web/server/providers/cloudflare.ts`: Cloudflare adapter. Uses Cloudflare's `WebSocketChatTransport` to produce standard AI SDK chunks, with the SDK's resume handshake. Each streaming request has its own temporary upstream connection. Opening the socket has a timeout; detaching removes its listeners and closes the connection. The adapter receives its configuration explicitly rather than reading environment variables.
- `apps/agent/agent.ts`: persistent agent, model selection, simulated one-minute tool, and cancellation endpoint. Cloudflare's SDK owns history and background execution.

To change agent providers, replace `apps/web/server/providers/cloudflare.ts` and the deployed agent implementation. Preserve the local HTTP contract and AI SDK message format. Existing stored history would still need migration if Cloudflare is removed.

## Reading the implementation

Start with `packages/chat-contract/src/index.ts` for the public contract. Then read `apps/web/server/server.ts`: configuration is validated at startup, `readMessages` validates request bodies, `handleRequest` selects an endpoint, and `streamChat` owns connection cleanup. Only `apps/web/server/providers/cloudflare.ts` knows Cloudflare's protocol. `apps/web/client/app.tsx` uses the standard AI SDK hook; its message rendering is separated from request and reconnect handling.

Client mistakes return 400 or 413. Upstream failures return 502 before streaming starts. A failure during SSE closes the response so the frontend can reconnect. Disconnecting a client and cancelling the agent remain deliberately separate operations.

## Setup — you perform these steps

Use Node **22.18+** and pnpm **11**. In this repository:

```sh
pnpm install --frozen-lockfile
pnpm --filter @playground/agent exec wrangler login
pnpm deploy
```

Cloudflare needs Workers onboarding, a `workers.dev` subdomain, permission to create SQLite Durable Objects, and Workers AI access. Wrangler creates the declared Durable Object binding and SQLite migration. No separately provisioned database, sandbox, or OpenAI key is required. If necessary, select the account with `CLOUDFLARE_ACCOUNT_ID` before deploying.

Deployment uploads only the Worker using `apps/agent/wrangler.jsonc`. The Worker name, Durable Object binding, and migration remain unchanged by the folder split. If you deployed the previous prototype, redeploy this version to add the cancellation endpoint. Existing `playground` history remains under the same Worker and Durable Object binding.

Create `.env.local` from `.env.example`, or edit your existing file:

```dotenv
AGENT_URL=https://cloudflare-agents-sdk-test.YOUR_SUBDOMAIN.workers.dev
```

Use **AGENT_URL**, replacing the previous **VITE_AGENT_URL** setting. This is backend configuration; it is not included in the browser bundle.

Then run these in separate terminals:

```sh
# Terminal 1: local backend
pnpm dev:server
```

```sh
# Terminal 2: local frontend
pnpm dev
```

Open **http://localhost:4315**. Both local processes must be running to use the page. Restart the local backend after changing `.env.local`. Real chat requests use your Cloudflare Workers AI allowance.

The Worker URL does not host the website. The existing `UI_ORIGIN` Worker setting is only a browser-origin restriction; the Node relay's server-to-server requests do not send an Origin header. This is a shared, unauthenticated throwaway conversation, not a production authorization design.

For Worker logs, run:

```sh
pnpm --filter @playground/agent exec wrangler tail --config wrangler.jsonc
```

Build output is written to `apps/web/dist` and `apps/agent/dist`. Old root `dist` and `.wrangler` directories are no longer used by these builds; any previous local state is left untouched.

## Try it

1. Send a message, reload, and verify the saved history.
2. Click **Run one-minute task**. Wait for tool activity, then stop both local processes and close the tab. Restart them after a minute: the completed answer should be in history.
3. Repeat, restarting the backend after about 15 seconds. Reopen the UI or click **Reconnect / refresh history** to attach to the existing turn. A broken active SSE connection also triggers an automatic retry.
4. Click **Stop** during the wait. This calls the backend cancellation endpoint. Closing the page or losing an SSE connection only detaches the client; it does not send Stop.

A passive second tab does not continuously subscribe to new turns. Use **Reconnect / refresh history** to load changes and attach to any active turn. This keeps idle clients from polling or holding an extra subscription. All tabs share `playground`; Stop cancels that conversation's current/queued work.

## Stable frontend contract

| Endpoint                          | Behavior                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET /api/chat/history`           | Saved `UIMessage[]`                                                                      |
| `POST /api/chat`                  | AI SDK request with `id: "playground"` and `messages`; response is UI Message Stream SSE |
| `GET /api/chat/playground/stream` | Replay/attach to the current turn, or return 204 when idle                               |
| `POST /api/chat/cancel`           | Explicitly cancel the agent's work; return 204                                           |

Resume uses Cloudflare's durable stream replay, not an in-memory stream buffer in the local backend. A replacement webserver opens a new connection to the same named agent. The prototype does not automatically retry message submission after an ambiguous network failure, since that could duplicate a turn.

Cloudflare may recover interrupted work by retrying it; persistence does not imply exactly-once tool execution. The demonstration wait is harmless to repeat. Authentication, multiple conversations, client-side tools/approvals, and continuous cross-tab synchronization are outside this prototype.

## Validation

```sh
pnpm typecheck
pnpm build
pnpm build:worker
pnpm format:check
pnpm test
```

`build:worker` is a dry run; it does not deploy. `pnpm test` starts an isolated local Worker and relay on ports 8791 and 4318, with an eight-second deterministic response and no AI binding. It verifies malformed requests, byte-based body limits, idle resume, replay after abruptly replacing the relay, tool results, saved history, completion with no relay connected, and explicit cancellation. It cleans up its processes and temporary storage.

These transport and lifecycle tests passed. Cloud deployment, model replies, and the production one-minute tool remain for you to verify. No cloud resources were deployed and no inference was performed during implementation. Temporary development services have been stopped.

References: [AI SDK transport](https://ai-sdk.dev/docs/ai-sdk-ui/transport), [UI Message Stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol), [Cloudflare chat client transport](https://developers.cloudflare.com/agents/communication-channels/chat/client-sdk/), [Workers AI setup](https://developers.cloudflare.com/workers-ai/get-started/workers-wrangler/).
