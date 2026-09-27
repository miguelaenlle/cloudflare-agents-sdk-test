# Conversations and durable approvals

See [architecture.md](architecture.md) for the complete ownership diagram and lifecycle state machine, and [testing.md](testing.md) for setup.

## Conversation admission

Postgres stores the relay's conversation catalog, admission revisions and operation IDs. Chat history remains in the Chat DO. A request supplies its operation ID and expected revision. A transaction admits only the current revision; identical retries do not increment it twice.

The browser receives separate AI SDK message SSE and snapshot-event SSE. The relay subscribes to Cloudflare state/history events and Postgres notifications before reading the initial snapshot. Reconnection reads current state; there is no history or diagnostics poll. A newer snapshot does not silently advance the draft's acknowledged revision.

## Tool gate versus approval decision

The Chat DO stores a generic pending tool request with an immutable payload. It blocks ordinary Send/steer until a result is delivered. The relay stores `push_sync` proposals, the user verdict, publication progress and delivery status in Postgres.

Waiting for approval uses `waiting_for_user` lifecycle policy. Idle cleanup interrupts native execution, creates the latest checkpoint and destroys the box. The durable gate and proposal survive. Reading the card or receiving events does not extend the idle deadline.

A decision is persisted before publication. The warm path answers the native tool; the cold path resumes the thread with a hidden, already-decided result. Both paths resolve the original gate. A regular user message cannot substitute for a missing decision.

## Explicit recovery

Approve runs publication, simulated sync and result delivery sequentially, with saved progress between stages. Incomplete operations remain approved and expose **Retry completion**. A shared database claim serializes completion attempts, and operation identity deduplicates GitHub publication and DO result delivery.

There is no publication/delivery polling loop. If the user never returns after a failure, the operation stays incomplete. This is an accepted prototype tradeoff.

See [push-sync-testing.md](push-sync-testing.md) for API publication, file restrictions and manual acceptance checks. The localhost relay still needs real PrairieLearn user/course authorization before production use.
