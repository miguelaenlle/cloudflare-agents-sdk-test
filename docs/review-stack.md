# Feature review stack

This checkout is layer 2: Sandbox lifecycle and recovery. Each layer includes its own running application and tests. The original PRs #2–#6 remain available for testing; the obsolete feature stack #7–#12 is closed.

| Layer | Branch | Review question |
| --- | --- | --- |
| 1 | `codex/review-v2-01-chat` | Are the end-to-end boundaries and credential isolation correct? |
| 2 | `codex/review-v2-02-lifecycle` | What survives disconnection, idle shutdown and unexpected loss? |
| 3 | `codex/review-v2-03-conversations` | How are conversations and stale tabs isolated? |
| 4 | `codex/review-v2-04-steering` | How does an active turn accept input and stream ordered output? |
| 5 | `codex/review-v2-05-approvals` | Can a blocked approval survive shutdown and deliver its decision? |
| 6 | `codex/review-v2-06-publication` | Does trusted code publish exactly the approved changes safely? |

Start from README.md for this layer's local commands and limitations. Run `pnpm typecheck`, `pnpm build`, and `pnpm test`. Full GitHub and Cloudflare acceptance is manual at layer 6. No credentials are committed.

Generated protocol types and dependency lockfile changes have separate commits where applicable. Runtime changes, regression tests and documentation stay together. Earlier branches intentionally omit later behavior; they are usable prototypes, not production releases.
