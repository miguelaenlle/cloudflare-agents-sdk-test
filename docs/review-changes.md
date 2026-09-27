# Review this update

Inherited changes are described in [tool flow](tool-flow.md). For this layer, review `apps/web/server/conversations.ts`: successful, denied and rejected publications all finalize the historical card through the generic tool-result endpoint before their latest-publication record becomes replaceable. GitHub API writes and explicit retry remain unchanged.

Previous head: `6dc4bdb`. Start with PR #14 for lifecycle changes, then #17 for generic dispatch and retention, then this integration diff.
