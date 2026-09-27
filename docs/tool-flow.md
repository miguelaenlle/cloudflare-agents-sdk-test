# Tool dispatch and publication ownership

The Chat DO uses the registry in `apps/agent/tools.ts`. An adapter supplies a Codex tool definition and `prepare(sandbox, args)`. The push_sync adapter captures immutable Git contents; the core DO does not interpret approval or Git schemas.

1. Codex emits `item/tool/call`; the DO validates the thread and turn, invokes the registered adapter, and persists a generic pending call with an increasing sequence.
2. The SDK broadcasts a state change. The relay's browser-scoped WebSocket watcher fetches a snapshot. Initial/reconnected snapshots use the same path; notifications are not a durable queue.
3. `apps/web/server/tools.ts` dispatches preparation by tool name. PL persists the proposal and owns the decision, publication, sync and retry state. With no connected browser, this work can wait until the next snapshot request.
4. The user decides. PL stores the outcome and sends `/tool-result` with an opaque finalized display payload. The DO persists that display in history before delivering the native result (warm) or hidden continuation (restored).
5. Only after delivery acknowledgment does PL mark the publication replaceable. A higher sequence replaces the completed row; an old snapshot cannot resurrect an earlier publication. Old decision IDs are rejected.

PostgreSQL retains one latest publication per conversation. History retains the reviewed diff, verdict and result, but not another copy of the published files. The browser renders that saved card at the original `data-tool` marker.

PL blocks sends while its latest publication is unfinished. The DO also guards generic pending execution, covering capture and notification races. Disconnecting the browser does not cancel Codex. There is no polling consumer or automatic publication retry.

## Updating an existing prototype

This round changes the prototype database schema and tool history format without compatibility migrations. Use a fresh development database (for example, `createdb course_agent_tools`, then set `DATABASE_URL=postgresql://localhost/course_agent_tools`) and create new conversations. Existing history is not automatically converted. The relay creates tables on startup.

## Startup and errors

Stop during setup records cancellation immediately. Setup finishes or fails before cleanup touches its sandbox; a cancelled setup never submits a native turn, and a replacement cannot overlap it. Warm/restored data is checkpointed before planned cancellation cleanup. Fresh, never-submitted workspaces can be destroyed directly.

Cleanup joins in-flight setup rather than checking cancellation around each SDK operation. An SDK timeout ends the wait on that operation; underlying remote work is subject to the SDK's timeout semantics. SDK errors are classified only from known structured codes or Error.name (which survives DO RPC), never by parsing arbitrary messages. Our own deadlines throw a distinct timeout error. Connection failures are sanitized once at the connectCodex boundary; individual SDK operations are called directly. Unknown causes produce a generic startup failure without a per-operation stage label.
