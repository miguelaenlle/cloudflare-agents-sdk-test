# Test real pushes with simulated Course Sync

Test repository: [miguelaenlle/course-agent-push-sync-test](https://github.com/miguelaenlle/course-agent-push-sync-test). It is private and was created empty, without an initial commit. The configured target branch is `main`.

## Credentials you create

Create **one fine-grained GitHub PAT** scoped only to this repository, with **Repository Contents: Read and write**. Configure the same value as `GITHUB_TOKEN` in both trusted services:

| Location                                                             | Use                                                  |
| -------------------------------------------------------------------- | ---------------------------------------------------- |
| Cloudflare Worker secret (local development: `apps/agent/.dev.vars`) | Injected only into allowed clone/fetch/pull requests |
| PL relay environment (`.env.local`)                                  | Publishes explicitly approved patches                |

The PAT has write permission, but the Worker outbound handler still rejects all push endpoints. The sandbox never receives the PAT itself. No Actions, Administration, or Workflows permission is needed. Do not put the PAT in Docker, the sandbox, the browser, Git remote URLs, tracked files, or Wrangler's plaintext `vars`.

Keep the existing `CODEX_API_KEY` and `RELAY_TOKEN` setup from [testing.md](testing.md).

## Local inference

1. In ignored `apps/agent/.dev.vars`, set:

   ```dotenv
   CODEX_API_KEY=your-openai-key
   GITHUB_REPOSITORY=miguelaenlle/course-agent-push-sync-test
   GITHUB_TOKEN=your-repository-pat
   ```

2. In ignored root `.env.local`, set:

   ```dotenv
   AGENT_URL=http://localhost:8790
   GITHUB_TOKEN=your-repository-pat
   PUSH_REPOSITORY=miguelaenlle/course-agent-push-sync-test
   PUSH_BRANCH=main
   ```

3. Run Docker, then `pnpm dev:agent`, **`pnpm dev:server`**, and `pnpm dev` in separate terminals. Use `dev:server` here because it loads `.env.local`; `dev:server:local` expects exported environment variables.
4. Open `http://localhost:4315` and create a **new conversation**. Old workspaces retain their existing repository and native tool definitions.

## Cloudflare sandbox

Set `vars.GITHUB_REPOSITORY` in `apps/agent/wrangler.jsonc` to `miguelaenlle/course-agent-push-sync-test` and set the shared PAT as a Worker secret:

```sh
pnpm --filter @playground/agent exec wrangler secret put GITHUB_TOKEN --config wrangler.jsonc
pnpm deploy
```

Keep `GITHUB_TOKEN` in root `.env.local` on the relay, along with `AGENT_URL` pointing to the deployed Worker and matching `RELAY_TOKEN`. Restart `pnpm dev:server`. Use the same PAT value in both places. Cloudflare enforces read-only sandbox access through its outbound request allowlist.

## First proposal in the empty repository

Ask the agent:

> The remote repository is empty. Configure a local Git author identity if needed. Create hello.txt containing “First approved change”, commit it locally, and call push_sync. Use forty zeros (0000000000000000000000000000000000000000) as baseSha and the full local commit SHA as proposedSha. Wait for my approval. Do not push directly.

The all-zero base means the configured remote branch must not yet exist. PL validates the exact patch in its own index and prepares a root commit. Before you approve, the GitHub repository remains empty.

Review the diff and displayed repository/branch. Click **Approve**. Expect:

- A real commit on GitHub's `main` branch containing exactly the approved patch.
- The relay prints the pushed SHA and **“sync would go here”**.
- Codex receives the real published SHA, the simulated sync status, and instructions to fetch, reconcile its checkout, then `git pull --ff-only` before continuing.

PL creates its own commit from the approved patch, so its SHA can differ from the sandbox's proposed commit. For the first root commit, the two local histories can be unrelated. The agent must reconcile onto the published commit, preserving any newer edits, before pulling; a blind pull from the original local root is insufficient.

## Follow-up checks

- **Deny:** propose another change and deny it. GitHub must remain unchanged.
- **Suspend:** leave a pending approval for ten minutes until the sandbox is absent. The stored patch remains actionable; approve, confirm the push, and check the restored agent receives the result.
- **Stale base:** change the remote branch separately after the diff appears, then approve. PL must report a conflict and must not overwrite the remote change.
- **Duplicate:** repeat an approval request/reload during publishing. The same operation must produce at most one commit.
- **Relay restart:** restart after approving. The persisted publication job and result outbox resume work and reconcile the prepared SHA with the remote before retrying.

Invalid proposals show an error and disable Approve; Deny remains available. Correct missing credentials/configuration and restart the relay before retrying validation, or deny and request a new proposal. Unknown network outcomes remain queued until the remote can be checked; they are not treated as confirmed push failures.

## Implementation boundaries

`apps/web/server/publish.ts` validates the hash/base, applies the patch in a separate trusted Git index, builds a deterministic candidate commit, rechecks the remote, and performs a normal non-force Git push. No proposed course files are executed or checked out on the relay. Git helpers, global configuration, hooks, and HTTP redirects are disabled. The PAT is supplied through child-process configuration, not arguments or saved Git configuration; Git errors are sanitized.

`apps/web/server/conversations.ts` pins the repository, branch, patch and candidate SHA in SQLite before approval/push, records decisions, and resumes interrupted jobs. Keep `.data/chat.sqlite` **and** `.data/publish/` together on the same durable local disk. This is still a single-host prototype; production PrairieLearn needs shared durable storage and user/course authorization.

Only regular text-file patches up to 256 KiB are supported. Binary patches, symlinks, submodules, path escapes, and `.github/` configuration are rejected. Course Sync is a printout, not a real PrairieLearn operation. Automated tests set `PUSH_MODE=simulated` for the sandbox fixture, and separately test actual Git pushes against a disposable local bare repository. Normal operation defaults to real publication and requires the PAT; it does not fall back to a user's GitHub CLI credentials.
