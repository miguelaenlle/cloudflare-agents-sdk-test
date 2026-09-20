# Prototype: replaceable agent behind a PL-style relay

1. **Persistent agent:** Cloudflare `AIChatAgent`, one named conversation, official Codex SDK running native Codex in a warm Sandbox. Implemented.
2. **Provider boundary:** React uses standard AI SDK `useChat` against a local Express backend. That backend converts Cloudflare's WebSocket transport to UI Message Stream SSE through the SDK's existing adapter. Implemented.
3. **Lifecycle proof:** Replace the local webserver during a turn, resume through a new process, finish with all clients disconnected, and explicitly cancel. Passed with a deterministic local agent using the real Cloudflare runtime and chat persistence. Live deployment/model checks are user-run.
4. **Later:** Add PL authentication and conversation IDs; decide whether passive tabs need continuous updates. Replace the provider adapter to test another runtime. Keep interactive approvals and preview servers outside this increment.

Keep the public contract to history, send, resume, and cancel. No custom frontend hook, protocol parser, or browser connection to Cloudflare. No durable state in ephemeral PL-style servers. See README.md for setup and explicit prototype limits.

## Deployment boundaries

- `apps/web`: browser UI and ephemeral Express relay, including its Cloudflare adapter.
- `apps/agent`: separately deployed Cloudflare Worker and local agent test fixture.
- `packages/chat-contract`: shared endpoints, request schema, and provider interfaces.

Each app has its own package manifest and TypeScript configuration. The root commands coordinate workspace tasks; `.env.local` remains at the root. No application behavior or deployed resource identifiers change in this split.

## Codex implementation

See [the direct Codex sandbox plan](docs/codex-sandbox-plan.md). Implemented locally; live container acceptance remains user-run. It keeps the existing chat coordinator and runs the full Codex harness through the official SDK inside Cloudflare Sandbox. Coordinator restart stops work and reports interruption; it does not automatically replay the prompt. The OpenAI Agents API is explicitly excluded.

Sandbox lifecycle follows the waiting-state subset of [Course agent MVP #15681](https://github.com/PrairieLearn/PrairieLearn/issues/15681): ten minutes waiting for the user triggers backup then destruction; an absolute six-hour generation lifetime overrides active work and restores from the last checkpoint next time. Cleanup retries are bounded. Approval/publishing states remain outside this prototype.
