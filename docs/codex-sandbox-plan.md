# Plan: run the Codex harness directly in Cloudflare Sandbox

Status: proposed; no sandbox integration has been implemented or deployed. The current prototype is committed as `52c7f2e` on `codex/prototype`.

## Decision

Run the actual Codex CLI inside a Cloudflare Linux sandbox. Keep the existing Cloudflare `AIChatAgent` as the durable chat coordinator. Replace its Workers AI model call with a background Codex process.

Do not use the OpenAI Agents API, a remotely managed Codex harness, or `codex exec-server`. The harness, tool loop, shell commands, and file editing run inside our container; model inference still uses the configured OpenAI service.

This is supported in principle: `codex exec` runs non-interactively, `--json` emits structured events, and `exec resume` continues a saved session. I verified those commands against the installed CLI help. Compatibility with Cloudflare's particular Linux container and permission features still needs the first live proof. [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive/).

## Architecture and ownership

```text
React useChat
  ↕ existing HTTP / AI SDK SSE
Ephemeral PL-style webserver
  ↕ existing Cloudflare adapter
Chat Durable Object / AIChatAgent
  ↕ Sandbox SDK process and file operations
Cloudflare Sandbox
  Codex CLI + workspace + Codex session files
  ↕ model inference
OpenAI
```

| Component                  | Responsibility                                                                    |
| -------------------------- | --------------------------------------------------------------------------------- |
| React and PL-style relay   | Same frontend, routes, and provider interface as today                            |
| `AIChatAgent`              | Saved UI transcript, active chat turn, client replay and cancellation entry point |
| Our Codex bridge           | Start/attach/stop a process, translate events, checkpoint workspace state         |
| Cloudflare Sandbox SDK     | Container lifecycle, background processes, logs, files, backup operations         |
| Codex CLI                  | Agent reasoning loop, tool execution, edits, compaction, native thread state      |
| R2, added for sleep/resume | Completed workspace and Codex session checkpoints                                 |

There are two different histories: the UI transcript in the Durable Object and Codex's native session files. A UI transcript is not a substitute for a resumable Codex session.

## Minimize the code we own

Keep everything new inside `apps/agent`:

```text
apps/agent/
  agent.ts           existing coordinator, new Codex execution path
  codex.ts           sandbox/process lifecycle and checkpoints
  codex-events.ts    Codex JSONL → AI SDK UIMessageChunk
  Dockerfile         pinned Sandbox image + pinned Codex CLI
  wrangler.jsonc     add Sandbox binding/container; later R2
  test/              deterministic fake Codex output + lifecycle checks
```

The package may need a tiny static launch script if process-group cancellation or exit recording cannot be expressed reliably with the SDK. Do not introduce a container HTTP server, queue, broker, custom frontend hook, or another agent framework by default.

Use `codex exec --json` first. The TypeScript Codex SDK also supports local threads, but it would still need to run inside the box and be connected to the Worker. Add it only if it demonstrably removes code from this bridge. App-server is a later option for interactive approvals or richer live events. [Codex SDK](https://developers.openai.com/codex/sdk/).

Pin compatible Sandbox SDK/image versions and the Codex CLI version. Use the stable Sandbox API for the initial experiment; do not mix it with 1.0-preview process APIs.

## Phase 1 — prove direct execution

Deliver a Dockerfile and a minimal backend-only smoke test.

1. Install Codex at image build time, never on every chat request. Confirm the binary executes in the selected container architecture.
2. Initialize a tiny disposable Git repository in `/workspace`; keep production PL code out of the initial proof.
3. Supply credentials at runtime. Start a non-interactive Codex process with an explicit working directory and permission policy.
4. Ask it to create a file and run a small test. Capture structured stdout, diagnostic stderr, exit status, and the emitted thread ID.
5. Start a second invocation using that explicit thread ID; verify it remembers the previous task and reads the file.

Use workspace-write permissions where supported. Test Linux sandbox compatibility explicitly; do not silently disable Codex's protection after a failure. The container's isolation and Codex's own command sandbox are separate mechanisms.

Pass prompts through stdin or an input file. Never interpolate prompt text into a shell command. Use a fixed launch command and validated application-generated identifiers for paths.

Acceptance: two successful turns, a verified file edit/test, no interactive terminal, and no custom model/tool loop.

## Phase 2 — connect the existing chat UI

Replace the body of `onChatMessage` with a stream built using the AI SDK's existing stream helpers. Keep the public `ChatProvider` contract and the webserver's Cloudflare adapter unchanged.

- One named sandbox and one Codex thread per conversation; one active turn at a time.
- Send only the new user input to the existing Codex thread. Do not resend the entire UI history on every turn.
- Store a small execution record with the Durable Object: Codex thread ID, application run ID, process ID, terminal outcome, and checkpoint reference.
- Run Codex with the Sandbox SDK's background-process API. Observing its logs must not own the process lifetime. [Background processes](https://developers.cloudflare.com/sandbox/guides/background-processes/).
- Parse complete JSONL lines across arbitrary log chunk boundaries. Keep stderr separate from protocol data.
- Derive stable UI message/tool identifiers from the run and Codex item IDs.

Initial event mapping:

| Codex output                       | UI result                                                             |
| ---------------------------------- | --------------------------------------------------------------------- |
| Assistant message item             | Text part; emit once at completion if incremental text is unavailable |
| Command execution/file-change item | Tool activity with arguments, status, and result                      |
| Turn completion                    | Finish the UI stream and persist the outcome                          |
| Turn failure/process failure       | Explicit error outcome                                                |

The CLI's event cadence is a phase-1 finding. Do not promise token-level streaming merely because stdout is streamed. Avoid inventing progress percentages or exposing internal reasoning content.

Acceptance: the same UI can request a file change, display tool activity, receive the answer, and reload its history.

## Phase 3 — prove independence from PL servers

Use the existing SDK durability and replay mechanisms rather than introducing another client event store.

1. Begin a Codex task containing a deliberate wait, then kill the local relay while it is running.
2. Reconnect through a new relay process to the same Durable Object. Verify one execution and a coherent transcript.
3. Repeat with all browser and relay connections absent until the task completes.
4. Make Stop propagate from the coordinator to the Codex process and its child commands. Bound termination, confirm the process has exited, and only then allow another turn.
5. Set a maximum run duration so a stuck task cannot keep the container alive indefinitely.

Persist a run identity before launching. Use a deterministic run directory and an atomic claim in the container to close the crash window between launching a process and saving its process ID. Record output/exit status there when the SDK's logs alone cannot support reattachment. A coordinator retry must attach to existing work or report interruption; it must not blindly launch the same edit twice.

Test coordinator recovery separately from PL recovery. If the container is still alive, reconcile its process/outcome. If it has died, report the turn as interrupted and recover from a checkpoint; do not claim exactly-once execution or automatically repeat side effects. Integrating that behavior with `AIChatAgent`'s recovery is a required test, not an assumed guarantee.

Acceptance: relay loss does not cancel work, Stop does cancel work, and retries cannot start duplicate Codex processes.

## Phase 4 — checkpoint, sleep, and resume

Sandbox identity does not imply a persistent disk. Cloudflare documents that container stop loses files and processes; `keepAlive` prevents ordinary idle sleep but does not make the process immortal. [Sandbox lifecycle](https://developers.cloudflare.com/sandbox/concepts/sandboxes/).

- Keep the sandbox awake while a turn is active and while saving its checkpoint.
- After a completed/cancelled turn, checkpoint the workspace and the Codex state needed to resume its thread. Determine the required files for the pinned CLI version; do not assume the thread ID alone is sufficient.
- Keep credentials outside the checkpointed directory. Recreate runtime credentials when waking the box.
- Use Sandbox backup/restore with R2, storing the completed backup reference in the Durable Object only after the backup succeeds. Restore into the same absolute paths before invoking Codex again. [Backup and restore](https://developers.cloudflare.com/sandbox/guides/backup-restore/).
- Release keep-alive after a successful checkpoint and allow a short configurable idle timeout. Handle backup failure with a bounded retry and an explicit error, not endless keep-alive or a false persistence guarantee.
- Add a durable cleanup deadline/alarm so a failed coordinator cannot leave keep-alive enabled forever. Reconcile the active run before cleanup.

Acceptance: let the sandbox actually stop; the next turn restores both files and native Codex context. A completed transcript remains readable without waking the container. A crash during a turn may lose work since the last checkpoint and must be reported honestly.

## Authentication and setup

Default to API-key authentication for this automated prototype. Store the key as a Worker secret and deliver it only to the Codex invocation. Do not bake it into the image, commit it, send it to the browser, or include it in logs/backups. The initial smoke repository must be trusted: an environment variable is not a security boundary against arbitrary code running inside that environment. Stronger credential isolation is required before using this with untrusted course/repository code.

ChatGPT-account authentication is a separate optional path. It involves sensitive, refreshable local authentication state and is not equivalent to supplying an API key. Do not automatically copy the developer's local Codex credentials into the sandbox. [Codex automation authentication](https://developers.openai.com/codex/noninteractive/#authenticate-in-automation).

The user performs cloud setup and deployment: Cloudflare Containers access, image building prerequisites, the Codex credential/model configuration, and R2 when phase 4 starts. Unlike the current Workers-AI-only experiment, sandbox compute and OpenAI inference have separate usage costs. No paid smoke test or deployment is part of preparing this plan.

## Completion criteria

Finish all four phases before calling the sandbox version equivalent to the current persistence prototype. Preserve the existing relay regression suite. Add recorded Codex-event fixtures for parsing/mapping and deterministic subprocess tests for disconnect, cancellation, duplicate launch prevention, and checkpoint failure. Then the user runs the live two-turn, relay-disconnect, and cold-resume checks.

Keep preview web servers, interactive approvals, multiple conversations, and new provider implementations outside this increment. The first proof is simply: edit files with native Codex, chat through the existing UI, survive PL server replacement, and sleep between turns without losing completed work.
