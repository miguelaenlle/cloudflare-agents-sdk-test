# Persistent Codex architecture

React/AI SDK → stateless PL relay → Chat Durable Object → Codex app-server in a Cloudflare Sandbox. Native Codex owns the model/tool loop. The Chat DO owns admission, UI history, lifecycle, and recovery.

**Implemented locally.** Tests cover the real app-server with a fake model endpoint and the real Cloudflare chat runtime with a simulated sandbox. Live outbound credential injection, container isolation, and R2 restore still need deployment verification. [Local testing and manual deployment](testing.md).

## Components and boundaries

The Worker entry point, Chat class, and Sandbox class are deployed together. Each DO instance has its own state/lifetime; the Linux container is a separate runtime.

```mermaid
flowchart TB
    subgraph browser["1 · Browser"]
        UI["React UI<br/>Vercel AI SDK useChat"]
    end
    subgraph backend["2 · PL webserver"]
        Relay["Express endpoints<br/>Provider adapter"]
    end
    subgraph cloudflare["One Worker deployment · separate runtime instances"]
        subgraph entry["3 · Worker entry point"]
            Router["Origin check + routeAgentRequest<br/>HTTP and WebSocket upgrade routing"]
        end
        subgraph chat["4 · Chat Durable Object — conversation ID"]
            Coordinator["AIChatAgent + our coordinator<br/>App-server client and UI event mapper"]
            SQLite[("DO SQLite<br/>History, replay, run state, deadlines")]
        end
        subgraph control["5 · Sandbox Durable Object — generation ID"]
            SandboxAPI["Cloudflare Sandbox SDK<br/>Provision, startProcess, wsConnect, backup"]
            Auth["Sandbox outbound handler<br/>Inject Worker-secret OpenAI key"]
        end
    end
    subgraph container["6 · Linux sandbox container"]
        Codex["Codex app-server<br/>One process across turns<br/>Native model/tool loop"]
        Files[("Workspace + native Codex session")]
    end
    subgraph model["7 · OpenAI"]
        Inference["Model inference"]
    end
    subgraph storage["Cloudflare R2"]
        Backup[("Workspace checkpoints")]
    end

    UI <-->|"HTTP requests / Vercel AI SDK SSE and JSON"| Relay
    Relay <-->|"HTTP requests / WebSocket upgrade"| Router
    Router <-->|"Cloudflare routing / upgrade response"| Coordinator
    Relay <-->|"Established WebSocket: resume / UI events"| Coordinator
    Coordinator <-->|"Cloudflare Sandbox SDK: operations + WebSocket connection"| SandboxAPI
    SandboxAPI <-->|"Cloudflare routing: app-server commands / events"| Codex
    Coordinator <-->|"Persist / load"| SQLite
    SandboxAPI <-->|"Backup / restore"| Backup
    Codex <-->|"Read / edit / execute"| Files
    Codex <-->|"Intercepted model requests / responses"| Auth
    Auth <-->|"Authenticated model requests / responses"| Inference

    classDef default fill:#374151,stroke:#9ca3af,color:#f9fafb
    style cloudflare fill:#111827,stroke:#6b7280,color:#f3f4f6
    style browser fill:#1f2937,stroke:#9ca3af,color:#f3f4f6
    style backend fill:#1f2937,stroke:#9ca3af,color:#f3f4f6
    style entry fill:#1f2937,stroke:#9ca3af,color:#f3f4f6
    style chat fill:#1f2937,stroke:#9ca3af,color:#f3f4f6
    style control fill:#1f2937,stroke:#9ca3af,color:#f3f4f6
    style container fill:#1f2937,stroke:#9ca3af,color:#f3f4f6
    style model fill:#1f2937,stroke:#9ca3af,color:#f3f4f6
    style storage fill:#1f2937,stroke:#9ca3af,color:#f3f4f6
    linkStyle default stroke:#9ca3af
```

Wrangler registers the exported DO classes and bindings. PL connects to `/agents/chat/playground`; `routeAgentRequest` selects that named Chat DO, and Cloudflare instantiates it as needed. Our HTTP message handler chooses start versus steer. For a new turn it calls `AIChatAgent.saveMessages`, which persists history/replay in the DO's SQLite and invokes our `onChatMessage`. The Worker routes the initial request/upgrade; we do not relay every WebSocket frame through another Worker handler.

### One turn: commands and responses

```mermaid
sequenceDiagram
    participant UI as Browser
    participant PL as PL backend
    box rgb(31,41,55) Cloudflare
        participant Chat as Chat DO
        participant Sandbox as Sandbox DO
    end
    participant Codex as Sandbox Codex app-server
    participant Auth as Sandbox outbound handler
    participant Model as OpenAI

    UI->>PL: POST /api/chat: message id + text
    PL->>Chat: HTTP /message: decide start or steer
    Chat->>Sandbox: CF Sandbox SDK: restore and startProcess if cold
    Chat->>Sandbox: CF Sandbox SDK: wsConnect on private port 4500
    Sandbox-->>Chat: Cloudflare-routed WebSocket to app-server
    Chat->>Codex: JSON-RPC initialize, then initialized
    Chat->>Codex: thread/start or thread/resume, then turn/start
    Chat-->>PL: Accepted after native start acknowledgment
    PL-->>UI: HTTP 204
    UI->>PL: GET history, then GET resume stream
    PL->>Chat: Cloudflare WebSocket resume transport
    loop Native model and tool iterations
        Codex->>Auth: HTTPS Responses request without API key
        Auth->>Model: Inject Worker-secret Authorization
        Model-->>Codex: HTTP response stream through handler
        Codex->>Codex: Run tools, edit files, save native session
        Codex-->>Chat: JSON-RPC item notifications over WebSocket
        Chat->>Chat: Map to AI SDK UIMessageChunk
        Chat-->>PL: AIChatAgent chat envelopes
        PL-->>UI: Standard AI SDK SSE
    end
    opt User sends another message while working
        UI->>PL: Same POST /api/chat: message id + text
        PL->>Chat: Same HTTP /message
        Chat->>Codex: turn/steer with current native turn ID
        Chat-->>UI: Acknowledge through PL, UI reloads history and reattaches
    end
    opt User stops
        UI->>PL: POST /api/chat/cancel
        PL->>Chat: HTTP /cancel
        Chat->>Codex: turn/interrupt
    end
    Codex-->>Chat: turn/completed with terminal status
    Chat->>Chat: waiting_for_user and close control socket
    Chat-->>UI: Final UI events through PL
    Note over Codex: App-server remains running between turns, no backup yet
    opt Ten minutes waiting for user
        Chat->>Sandbox: Back up workspace and native session to R2
        Sandbox-->>Chat: Backup reference
        Chat->>Chat: Persist backup reference and native thread ID
        Chat->>Sandbox: Destroy sandbox
    end
```

The diagram's Chat ↔ Codex arrows use the socket returned by Cloudflare's Sandbox SDK. **Cloudflare owns DO RPC and container routing. We own JSON-RPC request matching and event conversion.** No stdout parsing, per-turn runner, cancellation marker, or Codex TypeScript SDK remains.

| Surface                                                                                           | Our code                                                       | Delegated                                                        |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| [Browser](../apps/web/client/app.tsx)                                                             | Small UI, submit/reattach, history/reconnect, Stop             | AI SDK message state and SSE                                     |
| [PL relay](../apps/web/server/server.ts) / [provider](../apps/web/server/providers/cloudflare.ts) | Routes, validation, connection lifetime                        | Express, Cloudflare chat transport, AI SDK SSE                   |
| [Worker entry](../apps/agent/worker.ts)                                                           | Public routing and origin checks                               | Agents routing                                                   |
| [Native turn](../apps/agent/codex-turn.ts)                                                        | Thread/turn startup, subscriptions, event conversion           | Codex app-server and existing event mapper                       |
| [Chat DO](../apps/agent/agent.ts)                                                                 | Turn admission, durable deadlines, checkpoints, reconciliation | AIChatAgent history/replay, Agents scheduling                    |
| [Sandbox bridge](../apps/agent/codex.ts)                                                          | Start/reuse process, connect, backup/restore calls             | Cloudflare Sandbox SDK                                           |
| [App-server client](../apps/agent/app-server.ts) / [mapper](../apps/agent/codex-events.ts)        | Request IDs, notifications → UI events                         | Generated native protocol types; Codex thread/turn and tool loop |
| [Sandbox policy](../apps/agent/sandbox.ts) / [outbound handler](../apps/agent/outbound.ts)        | Allowed hosts and credential injection                         | Cloudflare outbound interception                                 |

## Unified message submission

`POST /api/chat` accepts `{ id, text }` and acknowledges with 204. The message ID is client-generated; the client does not supply a run ID or choose start versus steer. Express forwards it to the Chat DO's HTTP `/message` route. The DO serializes these control operations with Stop, independently of the long-running response.

- With a live nonterminal turn, deliver `turn/steer` and persist the accepted user message.
- With no active turn, call `saveMessages` to run a new library-managed response; acknowledge once Codex accepts `turn/start`.
- If steering is explicitly rejected and the native turn is confirmed terminal, wait for the old turn's transcript finalization and start a new turn with that message.
- A disconnect or timeout is an uncertain result, not evidence of rejection. Do not fall back to `turn/start` or automatically resend.
- An already persisted message ID is acknowledged without executing again. This is not an exactly-once guarantee across native acceptance and DO persistence; an uncertain steering request needs reconciliation before a manual retry.

Output uses `GET /api/chat/playground/stream` and the existing Cloudflare WebSocket resume adapter. The frontend still uses `useChat`/`DefaultChatTransport` to assemble AI SDK events, but owns the small HTTP submit action. On Send, it detaches its current subscriber, submits, reloads history, and resumes the stream. Codex keeps working during detachment. Replaying on each Send avoids maintaining separate steering notes or simultaneous streams that update the same assistant message.

## Commands we run

Cold startup creates/restores `/workspace`, copies the [Codex config](../apps/agent/codex-config.toml), and launches:

```sh
codex app-server --listen ws://0.0.0.0:4500 \
  --ws-auth capability-token --ws-token-file /tmp/codex-app-server-token
```

The process receives `CODEX_HOME=/workspace/codex`, **no OpenAI API key**. The private control token is separate from model credentials and excluded from backups. Readiness and protocol initialization complete before a turn is submitted.

Subsequent prompts use `thread/resume` and `turn/start`; steering uses `turn/steer` with the expected turn ID; Stop uses `turn/interrupt`. App-server stays running. A turn includes all model and tool steps until `turn/completed`, not just one tool call. Close the control socket after finalization; reconnect for the next prompt.

[protocol.ts](../apps/agent/protocol.ts) is generated from pinned Codex **0.155.0**. The client checks JSON-RPC envelopes; payload types trust this authenticated, version-pinned endpoint. It is not full runtime schema validation. WebSocket app-server transport is experimental upstream.

## Lifecycle

A new chat starts without a sandbox. **The user sends the first prompt; startup runs that pending prompt.**

```mermaid
flowchart TD
    Initial(("New conversation"))
    Offline["No sandbox allocated<br/>Waiting for a user message"]
    Starting["Starting<br/>Create or restore and start app-server"]
    Working["Running the submitted prompt<br/>waiting_for_agent"]
    Waiting["Sandbox ready<br/>waiting_for_user"]
    Saving["Checkpoint before idle shutdown"]
    Destroying["Destroying sandbox"]

    Initial --> Offline
    Offline -->|"User sends a message"| Starting
    Starting -->|"Submit that prompt"| Working
    Working -->|"turn/completed and finalization"| Waiting
    Working -->|"Accepted steering: same turn"| Working
    Waiting -->|"User sends next prompt"| Working
    Waiting -->|"10 minutes waiting"| Saving
    Saving -->|"Checkpoint succeeds"| Destroying
    Saving -->|"Backup fails: bounded retry"| Waiting
    Working -->|"6 hours without user interaction"| Deadline["Attempt bounded interruption and backup"]
    Waiting -->|"6 hours without user interaction"| Deadline
    Deadline -->|"Success, failure, or timeout"| Destroying
    Destroying -->|"Destruction confirmed"| Offline

    classDef default fill:#374151,stroke:#9ca3af,color:#f9fafb
    linkStyle default stroke:#9ca3af
```

| Timer                            | Reset by                                       | Action                                                       |
| -------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| Six hours since user interaction | Accepted prompt, steering, or active-turn Stop | Durable alarm: bounded interruption/checkpoint, then destroy |
| Ten minutes waiting for user     | Next turn invalidates the waiting period       | Checkpoint, then destroy                                     |
| Cloudflare `sleepAfter: "6h"`    | Activity recognized by the container interface | Infrastructure idle shutdown; `keepAlive: false`             |

There is **no absolute sandbox-age cap and no per-turn process timeout**. Steering can extend the same turn beyond six hours. Model/tool output, history reads, reconnects, and duplicate/rejected steering do not reset the application deadline. Agents `schedule()` persists callbacks; generation IDs and timestamps reject stale callbacks.

An open proxied control WebSocket prevents Cloudflare idle expiry in the installed container library. Local file/CPU activity alone is not an idle reset. Our application alarm bounds active work even while the socket remains open.

| Failure                                           | Behavior                                                                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Stop acknowledgment without terminal notification | Wait up to five seconds after acknowledgment, report unconfirmed Stop; keep new turns blocked                                     |
| Connection/DO lost after submission               | Reconnect and inspect the native thread; stop surviving work before admitting another turn; never replay the prompt automatically |
| Container/process lost                            | Destroy the old generation, report interruption; a user prompt can restore the last checkpoint                                    |
| Pre-idle backup fails                             | Return to waiting and retry; do not destroy without that backup                                                                   |
| Destruction fails/unknown                         | Retain generation as `cleanup_failed`; block replacement                                                                          |
| Cleanup retry budget exhausted                    | Three total attempts, 30 seconds apart; next prompt may explicitly retry                                                          |
| Restore fails/backup expired                      | Surface the error; do not invent native context from UI history                                                                   |

The six-hour deadline attempts interruption for at most five seconds and a final backup for at most ten seconds, then destroys regardless. Idle cleanup waits for its backup before destruction; ordinary turn completion does not back up. If native execution cannot be confirmed stopped, deadline cleanup skips the backup and destroys. Destruction retries do not repeat a backup already attempted during shutdown. Destruction confirmation is bounded to 30 seconds; a timeout is an uncertain result, not proof of destruction. Cloudflare outages can delay cleanup.

Run outcomes (`completed`, `cancelled`, `failed`, `interrupted`) are separate from sandbox phases. Browser/PL disconnection changes neither lifecycle nor execution. App-server recovery does not promise replay of every missed tool event; UI history receives a terminal result/interruption after reconciliation.

## Persistence and credentials

| Data                                                       | Storage                                      |
| ---------------------------------------------------------- | -------------------------------------------- |
| UI messages, stream replay, run/thread/turn IDs, deadlines | Chat DO SQLite                               |
| Native model context + repository                          | `/workspace/codex` + `/workspace/repo`       |
| Workspace/session recovery                                 | R2 checkpoints, paired with native thread ID |
| Control token + diagnostics                                | `/tmp`, outside checkpoints                  |
| OpenAI credential                                          | Worker secret, used only by outbound handler |

Checkpoints happen only immediately before planned destruction. Completion, steering, Stop, and recovery do not back up a sandbox being retained. Idle cleanup requires a successful checkpoint; the six-hour inactivity deadline attempts one even when the sandbox is already idle, but proceeds with destruction if backup fails or times out. They save files, not a live process. Native app-server remains running; backup consistency with its background metadata writes still needs live verification. UI history and backups are not atomic; history may describe work missing from a restored checkpoint. Unexpected loss can discard all workspace/native-session changes since the last successful pre-destruction checkpoint. Before the first checkpoint, cold startup creates a fresh workspace/thread. Infrastructure shutdown is not a guaranteed application backup hook. Backups expire after 30 days; configure R2 deletion separately.

The Sandbox subclass allows `api.openai.com` and the configured R2 account host. For OpenAI it permits only HTTPS POSTs to `/v1/responses` and `/v1/responses/compact`, replaces Authorization, strips container-supplied project/organization headers, and rejects redirects. Codex uses HTTP Responses with model WebSockets disabled. Cloudflare's SDK uses presigned URLs for R2 transfer; permanent R2 keys remain Worker secrets. Other internet destinations are blocked, including package/Git hosts until explicitly added.

No OpenAI-key redaction pipeline is needed because the key is never sent into the container. This does not sanitize unrelated secrets in prompts/files or impose spending limits. Legacy credential paths remain excluded from backups; previous backups are not scrubbed retroactively. The app-server control token is container-readable and protects the private socket, not the model account.

## Scope and verification

Two deployments: `apps/web` and `apps/agent`; the shared chat contract is source code, not a service. Preserve history/send/resume/cancel and AI SDK events when replacing Cloudflare; replace the provider adapter and migrate state.

- Trusted disposable prototype: one shared conversation, no user authentication/approval UI. Origin checks are not authorization.
- Two-window synchronization remains a gap. Course checkout/push_sync, previews, and usage accounting are deferred.
- Unit tests cover protocol matching, mapper behavior, and outbound policy. Integration tests exercise real AIChatAgent/relay behavior against a simulated sandbox. The native test runs pinned app-server against a fake local model endpoint.
- Live acceptance still requires Cloudflare HTTPS interception/TLS trust, workspace sandbox/tool execution, private socket authentication, and real R2 backup/restore. No deployment or paid inference is included in local checks.

References: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Cloudflare WebSockets](https://developers.cloudflare.com/sandbox/guides/websocket-connections/), [outbound handlers](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/), [backups](https://developers.cloudflare.com/sandbox/guides/backup-restore/).
