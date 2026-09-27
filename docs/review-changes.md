# Review this update

1. `apps/agent/tools.ts` and `codex-turn.ts`: adapter registration replaces a hardcoded push_sync callback.
2. `apps/agent/agent.ts`: generic pending calls, result delivery, and opaque historical display payloads.
3. `apps/web/server/tools.ts` and `conversations.ts`: PL dispatch, one latest publication, and historic card hydration.
4. `apps/web/server/conversations.sql`: replacement requires delivered=true and a higher call sequence.
5. `apps/web/client/app.tsx`: finalized cards remain at their original markers.

See `tool-flow.md` for ownership and the browser-scoped notification behavior. Previous head: `88ea5b027e1b02c7c9378b1084528f6715e396d5`.
