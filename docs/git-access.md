# Git access

The prototype repository is configured by `GITHUB_REPOSITORY` in the shared contract, not Wrangler. PrairieLearn can later resolve it from an authorized course.

Set the same repository-scoped read/write PAT as `GITHUB_TOKEN` in the Worker and PL relay. Local Worker secrets go in `apps/agent/.dev.vars`; relay secrets go in `.env.local`. The sandbox never receives that token.

The sandbox outbound handler accepts only Git upload-pack discovery and fetch requests for the configured repository. It injects credentials on the trusted side and forwards over HTTPS. Push, unrelated repositories, arbitrary API requests, and redirects are rejected. The local sandbox uses HTTP to the interception endpoint because local TLS interception is unavailable.

A fresh sandbox clones the repository. Checkpoint recovery restores the workspace instead of cloning over it. Codex gets a default Git commit identity. This PR does not implement publication: the subsequent push-sync PR publishes through PL after approval.

Local validation: `pnpm --filter @playground/agent test`. Git credential tests use fake requests and never contact GitHub.
