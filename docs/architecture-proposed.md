# Proposed architecture — implementation status

The proposal is now implemented in this branch. [Current architecture and diagrams](architecture.md) · [Setup and acceptance checks](../README.md).

| Proposed change                       | Implementation                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| One Codex app-server per warm sandbox | Pinned native CLI, private CF Sandbox SDK WebSocket; process survives turns and socket disconnects                     |
| Steering and Stop                     | `turn/steer` / `turn/interrupt`, correlated with native IDs; small controls in the existing UI                         |
| No OpenAI key in the container        | Sandbox outbound handler injects the Worker secret for allowed HTTPS Responses requests                                |
| Remove runner and stdout transport    | Removed per-turn Node runner, SDK runtime dependency, input/result files, cancel watcher, and redaction pipeline       |
| `keepAlive: false`                    | Set with CF `sleepAfter: "6h"`; control socket closes between turns                                                    |
| Remove absolute sandbox-age TTL       | Durable sliding deadline: six hours after accepted prompt, steer, or active-turn Stop                                  |
| Keep waiting-state cleanup            | Checkpoint/destroy after ten minutes waiting for the user                                                              |
| Reconcile uncertainty                 | Inspect native execution, stop surviving work, never automatically replay a prompt; retain failed-destruction identity |

Browser/PL HTTP/SSE, the provider adapter, Chat DO history/replay, and R2 checkpoints remain. Cloudflare manages DO RPC and sandbox routing; our small client manages Codex JSON-RPC correlation and maps notifications to Vercel AI SDK events.

## Remaining validation and follow-ups

- Verify the complete deployed path: outbound HTTPS interception/TLS trust, private WebSocket authentication, tool sandboxing, and R2 checkpoint/restore.
- Keep turn-end and pre-idle checkpoints initially. Measure cost and acceptable data loss before reducing frequency; a persistent server may write session metadata in the background.
- Add `push_sync` later with a separate destination-specific credential policy. Current internet access is limited to OpenAI and the configured R2 account host.
- Keep multi-window synchronization, course sync/publishing, previews, and usage accounting outside this prototype.

Local native app-server tests use a fake model endpoint; lifecycle/relay tests use a simulated sandbox. Neither substitutes for a live Cloudflare smoke test.
