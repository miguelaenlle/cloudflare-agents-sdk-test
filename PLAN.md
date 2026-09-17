# Prototype: replaceable agent behind a PL-style relay

1. **Persistent agent:** Cloudflare `AIChatAgent`, Workers AI, one named conversation, one-minute tool. Implemented.
2. **Provider boundary:** React uses standard AI SDK `useChat` against a local Node backend. That backend converts Cloudflare's WebSocket transport to UI Message Stream SSE through the SDK's existing adapter. Implemented.
3. **Lifecycle proof:** Replace the local webserver during a turn, resume through a new process, finish with all clients disconnected, and explicitly cancel. Passed with a deterministic local agent using the real Cloudflare runtime and chat persistence. Live deployment/model checks are user-run.
4. **Later:** Add PL authentication and conversation IDs; decide whether passive tabs need continuous updates. Replace the provider adapter to test another runtime. Consider sandbox/Codex only after the chat lifecycle works.

Keep the public contract to history, send, resume, and cancel. No custom frontend hook, protocol parser, or browser connection to Cloudflare. No durable state in ephemeral PL-style servers. See README.md for setup and explicit prototype limits.

## Deployment boundaries

- `apps/web`: browser UI and ephemeral Node relay, including its Cloudflare adapter.
- `apps/agent`: separately deployed Cloudflare Worker and local agent test fixture.
- `packages/chat-contract`: shared endpoints, request schema, and provider interfaces.

Each app has its own package manifest and TypeScript configuration. The root commands coordinate workspace tasks; `.env.local` remains at the root. No application behavior or deployed resource identifiers change in this split.

## Next implementation

See [the direct Codex sandbox plan](docs/codex-sandbox-plan.md). It keeps the existing chat coordinator and runs the full Codex harness inside Cloudflare Sandbox. The OpenAI Agents API is explicitly excluded.
