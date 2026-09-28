# Test real publication with simulated Course Sync

Target: `miguelaenlle/course-agent-push-sync-test`, branch `main`. Initialize `main` with a README commit before testing. The publisher requires an existing branch.

## Configuration

Use one fine-grained PAT scoped to this test repository with Contents: Read and write. Set the same `GITHUB_TOKEN` in the Worker secret (or local `.dev.vars`) and relay environment. The Worker only authorizes repository reads; the sandbox never receives the PAT. GitHub writes occur only in the trusted relay after approval.

The relay also needs `DATABASE_URL` pointing to a dedicated Postgres database. Set `AGENT_URL` and `RELAY_TOKEN` for the Worker you are testing. Do not set `PUSH_MODE=simulated` when testing real commits; Course Sync remains simulated regardless.

Follow [testing.md](testing.md) to start the local or deployed Worker, relay and UI. Deployment remains manual.

## Happy path

Ask Codex to create an ordinary UTF-8 text file, commit it locally, and call `push_sync` with the original base SHA and proposed SHA. The relay captures no mutable worktree state: the tool payload contains final committed file contents and deletions.

Before approval, check the raw diff in the card. The relay generates this diff against GitHub base blobs using the exact saved file contents that will be published. The sandbox-provided visual diff is not used to apply changes.

Approve, then verify:

- GitHub main has a new commit containing the reviewed files.
- The commit message identifies the approval operation and content digest.
- The card remains in place and shows the approved decision/result.
- The agent receives the result and is instructed to fetch, reconcile and pull.
- Course Sync reports `sync would go here`.
- The relay has created no Git checkout or patch files.

The GitHub SHA can differ from Codex's local proposed SHA. The agent must reconcile its checkout to the published commit while preserving newer edits before pulling.

## Recovery checks

- **Deny:** no GitHub write or simulated sync should occur.
- **Suspend:** let the pending tool reach idle cleanup and confirm the sandbox becomes absent. The approval remains visible. Approve or deny afterward; ordinary Send must not bypass the gate.
- **Restart:** stop the relay during completion. Restart, refresh and press **Retry completion**. The stored verdict cannot be changed.
- **Lost write acknowledgment:** the automated fake GitHub test creates a commit and loses its response. Retry finds the existing operation in branch history, even after another commit is appended.
- **Concurrent main change:** a proposal cannot overwrite another commit. It reports the conflict to the agent, which must fetch and prepare a new proposal.
- **Concurrent Retry:** the database claim permits one active completion attempt. A second caller receives a retryable busy response.

No background job completes abandoned publication operations. The user must explicitly Retry after an error; that is an intentional prototype tradeoff.

## Supported scope

GitHub `createCommitOnBranch` performs the commit/ref update using `expectedHeadOid`. Publication uses APIs only. This version supports ordinary text files and deletions, with a 256 KiB proposal bound. Executable-mode changes, symlinks, submodules, binary data and `.github/` changes are rejected. Do not force-push/rewrite the test branch while recovering an operation.

Automated tests mock GitHub, including failures after its external effect, and exercise the workflow against real local Postgres. They do not contact GitHub. Real GitHub and Cloudflare acceptance is manual.
