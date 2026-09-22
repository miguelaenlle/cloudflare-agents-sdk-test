// Generated from Codex 0.155.0 (Apache-2.0). Do not edit.
// Regenerate with pnpm --filter @playground/agent generate:protocol.

export type ClientInfo = {
  name: string;
  title: string | null;
  version: string;
};

export type JsonValue =
  | number
  | string
  | boolean
  | Array<JsonValue>
  | { [key in string]?: JsonValue }
  | null;

/**
 * Client-declared capabilities negotiated during initialize.
 */
export type InitializeCapabilities = {
  /**
   * Opt into receiving experimental API methods and fields.
   */
  experimentalApi: boolean;
  /**
   * Opt into `attestation/generate` requests for upstream `x-oai-attestation`.
   */
  requestAttestation: boolean;
  /**
   * Legacy opt-in for the `openai/form` MCP extension.
   *
   * New clients should declare `openai/form` in [`Self::extensions`].
   */
  mcpServerOpenaiFormElicitation?: boolean;
  /**
   * Exact notification method names that should be suppressed for this
   * connection (for example `thread/started`).
   */
  optOutNotificationMethods?: Array<string> | null;
  /**
   * MCP extension settings declared by the app-server client.
   */
  extensions?: { [key in string]?: JsonValue } | null;
};

export type InitializeParams = {
  clientInfo: ClientInfo;
  capabilities: InitializeCapabilities | null;
};

export type Personality = "none" | "friendly" | "pragmatic";

/**
 * Configures who approval requests are routed to for review. Examples
 * include sandbox escapes, blocked network access, MCP approval prompts, and
 * ARC escalations. Defaults to `user`. `auto_review` uses a carefully
 * prompted subagent to gather relevant context and apply a risk-based
 * decision framework before approving or denying the request.
 */
export type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";

export type AskForApproval =
  | "untrusted"
  | "on-request"
  | {
      granular: {
        sandbox_approval: boolean;
        rules: boolean;
        skill_approval: boolean;
        request_permissions: boolean;
        mcp_elicitations: boolean;
      };
    }
  | "never";

export type SandboxMode =
  "read-only" | "workspace-write" | "danger-full-access";

export type ThreadSource = string;

export type ThreadStartSource = "startup" | "clear";

export type ThreadStartParams = {
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null; /**
   * Override where approval requests are routed for review on this thread
   * and subsequent turns.
   */
  approvalsReviewer?: ApprovalsReviewer | null;
  sandbox?: SandboxMode | null;
  config?: { [key in string]?: JsonValue } | null;
  serviceName?: string | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: Personality | null;
  ephemeral?: boolean | null;
  sessionStartSource?: ThreadStartSource | null; /**
   * Optional client-supplied analytics source classification for this thread.
   */
  threadSource?: ThreadSource | null;
};

/**
 * There are three ways to resume a thread:
 * 1. By thread_id: load the thread from disk by thread_id and resume it.
 * 2. By history: instantiate the thread from memory and resume it.
 * 3. By path: load the thread from disk by path and resume it.
 *
 * For non-running threads, the precedence is: history > non-empty path > thread_id.
 * If using history or a non-empty path for a non-running thread, the thread_id
 * param will be ignored.
 *
 * If thread_id identifies a running thread, app-server rejoins that thread and
 * treats a non-empty path as a consistency check against the active rollout path.
 * Empty string path values are treated as absent.
 *
 * Prefer using thread_id whenever possible.
 */
export type ThreadResumeParams = {
  threadId: string; /**
   * Configuration overrides for the resumed thread, if any.
   */
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null; /**
   * Override where approval requests are routed for review on this thread
   * and subsequent turns.
   */
  approvalsReviewer?: ApprovalsReviewer | null;
  sandbox?: SandboxMode | null;
  config?: { [key in string]?: JsonValue } | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: Personality | null; /**
   * When true, return only thread metadata and live-resume state without
   * populating `thread.turns`. This is useful when the client plans to call
   * `thread/turns/list` immediately after resuming. Full-history hydration
   * is deprecated for paginated threads; use this with `thread/turns/list`
   * and `thread/items/list` instead.
   */
  excludeTurns?: boolean;
};

export type ThreadReadParams = {
  threadId: string;
  /**
   * When true, include turns and their items from rollout history.
   * Full-history hydration is deprecated for paginated threads; prefer a
   * metadata-only read and page with `thread/turns/list` and
   * `thread/items/list`.
   */
  includeTurns?: boolean;
};

/**
 * See https://platform.openai.com/docs/guides/reasoning?api-mode=responses#get-started-with-reasoning
 */
export type ReasoningEffort = string;

/**
 * A summary of the reasoning performed by the model. This can be useful for
 * debugging and understanding the model's reasoning process.
 * See https://platform.openai.com/docs/guides/reasoning?api-mode=responses#reasoning-summaries
 */
export type ReasoningSummary = "auto" | "concise" | "detailed" | "none";

/**
 * A path that is guaranteed to be absolute and normalized (though it is not
 * guaranteed to be canonicalized or exist on the filesystem).
 *
 * IMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set
 * using [AbsolutePathBufGuard::new]. If no base path is set, the
 * deserialization will fail unless the path being deserialized is already
 * absolute.
 */
export type AbsolutePathBuf = string;

export type NetworkAccess = "restricted" | "enabled";

export type SandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "externalSandbox"; networkAccess: NetworkAccess }
  | {
      type: "workspaceWrite";
      writableRoots: Array<AbsolutePathBuf>;
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

export type ImageDetail = "auto" | "low" | "high" | "original";

/**
 * Responses API compatible content items that can be returned by a tool call.
 * This is a subset of ContentItem with the types we support as function call outputs.
 */
export type FunctionCallOutputContentItem =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: ImageDetail }
  | { type: "input_audio"; audio_url: string }
  | { type: "encrypted_content"; encrypted_content: string };

export type FunctionCallOutputBody =
  string | Array<FunctionCallOutputContentItem>;

export type TurnToolOutput = {
  name: string;
  namespace: string | null;
  output: FunctionCallOutputBody;
};

export type ByteRange = { start: number; end: number };

export type TextElement = {
  /**
   * Byte range in the parent `text` buffer that this element occupies.
   */
  byteRange: ByteRange;
  /**
   * Optional human-readable placeholder for the element, displayed in the UI.
   */
  placeholder: string | null;
};

export type UserInput =
  | {
      type: "text";
      text: string;
      /**
       * UI-defined spans within `text` used to render or persist special elements.
       */
      text_elements: Array<TextElement>;
    }
  | { type: "image"; detail?: ImageDetail; url: string }
  | { type: "localImage"; detail?: ImageDetail; path: string }
  | { type: "audio"; url: string }
  | { type: "localAudio"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export type TurnStartParams = {
  threadId: string;
  clientUserMessageId?: string | null;
  input: Array<UserInput>; /**
   * Optional source classification for the caller that starts this turn.
   * Ignored when this request steers an already-active turn.
   */
  turnTrigger?: string | null;
  toolOutput?: TurnToolOutput | null; /**
   * Override the working directory for this turn and subsequent turns.
   */
  cwd?: string | null; /**
   * Override the approval policy for this turn and subsequent turns.
   */
  approvalPolicy?: AskForApproval | null; /**
   * Override where approval requests are routed for review on this turn and
   * subsequent turns.
   */
  approvalsReviewer?: ApprovalsReviewer | null; /**
   * Override the sandbox policy for this turn and subsequent turns.
   */
  sandboxPolicy?: SandboxPolicy | null; /**
   * Override the model for this turn and subsequent turns.
   */
  model?: string | null; /**
   * Override the service tier for this turn and subsequent turns.
   */
  serviceTier?: string | null | null; /**
   * Override the service tier only when this request starts a new turn.
   * Use "default" for standard speed. Omitted or null inherits the thread's tier.
   * Does not change the thread's tier or a turn being steered.
   */
  serviceTierForTurn?: string | null; /**
   * Override the reasoning effort for this turn and subsequent turns.
   */
  effort?: ReasoningEffort | null; /**
   * Override the reasoning summary for this turn and subsequent turns.
   */
  summary?: ReasoningSummary | null; /**
   * Override the personality for this turn and subsequent turns.
   */
  personality?: Personality | null; /**
   * Optional JSON Schema used to constrain the final assistant message for
   * this turn.
   */
  outputSchema?: JsonValue | null;
};

export type TurnSteerParams = {
  threadId: string;
  clientUserMessageId?: string | null;
  input: Array<UserInput>; /**
   * Required active turn id precondition. The request fails when it does not
   * match the currently active turn.
   */
  expectedTurnId: string;
};

export type TurnInterruptParams = { threadId: string; turnId: string };

export type GitInfo = {
  sha: string | null;
  branch: string | null;
  originUrl: string | null;
};

export type AgentPath = string;

/**
 * Identifier for a Codex thread.
 *
 * Codex-generated thread IDs are UUIDv7, and some use cases rely on that.
 */
export type ThreadId = string;

export type SubAgentSource =
  | "review"
  | "compact"
  | {
      thread_spawn: {
        parent_thread_id: ThreadId;
        depth: number;
        agent_path: AgentPath | null;
        agent_nickname: string | null;
        agent_role: string | null;
      };
    }
  | "memory_consolidation"
  | { other: string };

export type SessionSource =
  | "cli"
  | "vscode"
  | "exec"
  | "appServer"
  | { custom: string }
  | { subAgent: SubAgentSource }
  | "unknown";

export type ThreadHistoryMode = "legacy" | "paginated";

/**
 * Extensible visual presentation for a custom thread section.
 */
export type ThreadSectionAppearance = {
  icon: string | null;
  color: string | null;
};

/**
 * An independently persisted, user-visible thread section.
 */
export type ThreadSection = {
  /**
   * Opaque UUIDv7 identity that remains stable when the section is renamed.
   */
  id: string;
  /**
   * The current user-visible section name.
   */
  name: string;
  /**
   * Optional appearance synchronized across clients.
   */
  appearance: ThreadSectionAppearance | null;
};

export type ThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput";

export type ThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags: Array<ThreadActiveFlag> };

export type ImageGenerationFailure = {
  type: "usageLimitExceeded";
  limitId: string;
  resetsAt: number | null;
};

export type ImageGenerationItem = {
  id: string;
  status: string;
  revisedPrompt: string | null;
  result: string;
  transparentBackground?: boolean;
  failure: ImageGenerationFailure | null;
  savedPath?: AbsolutePathBuf;
};

/**
 * A UTF-8 path for preserving raw path compatibility at the app-server API
 * boundary while Codex migrates to [`PathUri`].
 *
 * Supports storing arbitrary strings read from the API and converting to and
 * from [`PathUri`] using an explicitly selected native path convention.
 *
 * When converting from [`PathUri`], "native" refers to the supplied
 * [`PathConvention`], which may be foreign to the operating system running
 * this process. The inner string is private so path-producing code must use a
 * path conversion method instead of bypassing the intended conversion
 * boundary. Non-UTF-8 paths are converted to UTF-8 lossily because this API
 * value is serialized as a JSON string.
 *
 * Deserialization and [`Self::from_string`] accept any UTF-8 string without
 * interpreting or validating it. Use [`Self::from_string`] when a caller
 * already owns legacy app-server path text and needs to preserve its wire
 * spelling; use [`Self::from_path`], [`Self::from_abs_path`], or
 * [`Self::from_path_uri`] when converting an actual path value. Relative
 * path text remains valid until an operation such as [`Self::to_path_uri`]
 * requires an absolute path.
 */
export type LegacyAppPathString = string;

/**
 * Classifies an assistant message as interim commentary or final answer text.
 *
 * Providers do not emit this consistently, so callers must treat `None` as
 * "phase unknown" and keep compatibility behavior for legacy models.
 */
export type MessagePhase = "commentary" | "final_answer";

/**
 * Display item emitted by the interruptible `clock.sleep` tool.
 */
export type SleepItem = { id: string; durationMs: number };

export type WebSearchAction =
  | { type: "search"; query: string | null; queries: Array<string> | null }
  | { type: "openPage"; url: string | null }
  | { type: "findInPage"; url: string | null; pattern: string | null }
  | { type: "other" };

export type WebSearchItem = {
  id: string;
  query: string;
  action: WebSearchAction | null;
  /**
   * Structured search results returned out-of-band by standalone web search.
   *
   * These stay as opaque JSON at the extension/app-server boundary so new
   * result fields and result types can pass through without a Codex release.
   */
  results: Array<JsonValue> | null;
};

export type AgentMessageDelivery = "async";

export type AsyncUserInputQuestion = {
  title: string;
  options: Array<string> | null;
};

export type CollabAgentStatus =
  | "pendingInit"
  | "running"
  | "interrupted"
  | "completed"
  | "errored"
  | "shutdown"
  | "notFound";

export type CollabAgentState = {
  status: CollabAgentStatus;
  message: string | null;
};

export type CollabAgentTool =
  | "spawnAgent"
  | "sendInput"
  | "resumeAgent"
  | "wait"
  | "closeAgent"
  | "sendMessage"
  | "followupTask"
  | "interruptAgent"
  | "listAgents";

export type CollabAgentToolCallStatus =
  "inProgress" | "completed" | "failed" | "interrupted";

export type CommandAction =
  | { type: "read"; command: string; name: string; path: LegacyAppPathString }
  | { type: "listFiles"; command: string; path: string | null }
  | {
      type: "search";
      command: string;
      query: string | null;
      path: string | null;
    }
  | { type: "unknown"; command: string };

export type CommandExecutionSource =
  "agent" | "userShell" | "unifiedExecStartup" | "unifiedExecInteraction";

export type CommandExecutionStatus =
  "inProgress" | "completed" | "failed" | "declined";

export type DynamicToolCallOutputContentItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string }
  | { type: "inputAudio"; audioUrl: string };

export type DynamicToolCallStatus = "inProgress" | "completed" | "failed";

export type PatchChangeKind =
  | { type: "add" }
  | { type: "delete" }
  | { type: "update"; move_path: string | null };

export type FileUpdateChange = {
  path: string;
  kind: PatchChangeKind;
  diff: string;
};

export type HookPromptFragment = { text: string; hookRunId: string };

export type McpToolCallAppContext = {
  connectorId: string;
  linkId: string | null;
  resourceUri: string | null;
  appName: string | null;
  actionName: string | null;
};

export type McpToolCallError = { message: string };

export type McpToolCallResult = {
  content: Array<JsonValue>;
  structuredContent: JsonValue | null;
  _meta: JsonValue | null;
};

export type McpToolCallStatus = "inProgress" | "completed" | "failed";

export type MemoryCitationEntry = {
  path: string;
  lineStart: number;
  lineEnd: number;
  note: string;
};

export type MemoryCitation = {
  entries: Array<MemoryCitationEntry>;
  threadIds: Array<string>;
};

export type PatchApplyStatus =
  "inProgress" | "completed" | "failed" | "declined";

export type SubAgentActivityKind =
  "started" | "interacted" | "interrupted" | "completed";

export type ThreadItem =
  | {
      type: "userMessage";
      id: string;
      clientId: string | null;
      content: Array<UserInput>;
    }
  | { type: "hookPrompt"; id: string; fragments: Array<HookPromptFragment> }
  | {
      type: "agentMessage";
      id: string;
      text: string;
      phase: MessagePhase | null;
      memoryCitation: MemoryCitation | null;
      delivery: AgentMessageDelivery | null;
      questions: Array<AsyncUserInputQuestion> | null;
    }
  | {
      type: "functionCallOutput";
      id: string;
      name: string;
      namespace: string | null;
      output: FunctionCallOutputBody;
    }
  | { type: "plan"; id: string; text: string }
  | {
      type: "reasoning";
      id: string;
      summary: Array<string>;
      content: Array<string>;
    }
  | {
      type: "commandExecution";
      id: string;
      /**
       * Trusted first-party plugin id when this command resolves to one plugin script.
       */
      pluginId: string | null;
      /**
       * Safe plugin-relative path when this command resolves to one plugin script.
       */
      scriptPath: string | null;
      /**
       * The command to be executed.
       */
      command: string;
      /**
       * The command's working directory.
       */
      cwd: LegacyAppPathString;
      /**
       * Identifier for the underlying PTY process (when available).
       */
      processId: string | null;
      source: CommandExecutionSource;
      status: CommandExecutionStatus;
      /**
       * A best-effort parsing of the command to understand the action(s) it will perform.
       * This returns a list of CommandAction objects because a single shell command may
       * be composed of many commands piped together.
       */
      commandActions: Array<CommandAction>;
      /**
       * The command's output, aggregated from stdout and stderr.
       */
      aggregatedOutput: string | null;
      /**
       * The command's exit code.
       */
      exitCode: number | null;
      /**
       * The duration of the command execution in milliseconds.
       */
      durationMs: number | null;
    }
  | {
      type: "fileChange";
      id: string;
      changes: Array<FileUpdateChange>;
      status: PatchApplyStatus;
    }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      status: McpToolCallStatus;
      arguments: JsonValue;
      appContext: McpToolCallAppContext | null;
      /**
       * Deprecated: use `appContext.resourceUri` instead.
       */
      mcpAppResourceUri?: string;
      pluginId: string | null;
      readOnlyHint: boolean | null;
      result: McpToolCallResult | null;
      error: McpToolCallError | null;
      /**
       * The duration of the MCP tool call in milliseconds.
       */
      durationMs: number | null;
    }
  | {
      type: "dynamicToolCall";
      id: string;
      namespace: string | null;
      tool: string;
      arguments: JsonValue;
      status: DynamicToolCallStatus;
      contentItems: Array<DynamicToolCallOutputContentItem> | null;
      success: boolean | null;
      /**
       * The duration of the dynamic tool call in milliseconds.
       */
      durationMs: number | null;
    }
  | {
      type: "collabAgentToolCall";
      /**
       * Unique identifier for this collab tool call.
       */
      id: string;
      /**
       * Name of the collab tool that was invoked.
       */
      tool: CollabAgentTool;
      /**
       * Current status of the collab tool call.
       */
      status: CollabAgentToolCallStatus;
      /**
       * Thread ID of the agent issuing the collab request.
       */
      senderThreadId: string;
      /**
       * Thread ID of the receiving agent, when applicable. In case of spawn operation,
       * this corresponds to the newly spawned agent.
       */
      receiverThreadIds: Array<string>;
      /**
       * Prompt text sent as part of the collab tool call, when available.
       */
      prompt: string | null;
      /**
       * Model requested for the spawned agent, when applicable.
       */
      model: string | null;
      /**
       * Reasoning effort requested for the spawned agent, when applicable.
       */
      reasoningEffort: ReasoningEffort | null;
      /**
       * Last known status of the target agents, when available.
       */
      agentsStates: { [key in string]?: CollabAgentState };
    }
  | {
      type: "subAgentActivity";
      id: string;
      kind: SubAgentActivityKind;
      agentThreadId: string;
      agentPath: string;
    }
  | ({ type: "webSearch" } & WebSearchItem)
  | { type: "imageView"; id: string; path: LegacyAppPathString }
  | ({ type: "sleep" } & SleepItem)
  | ({ type: "imageGeneration" } & ImageGenerationItem)
  | { type: "enteredReviewMode"; id: string; review: string }
  | { type: "exitedReviewMode"; id: string; review: string }
  | { type: "contextCompaction"; id: string };

export type NonSteerableTurnKind = "review" | "compact";

/**
 * This translation layer make sure that we expose codex error code in camel case.
 *
 * When an upstream HTTP status is available (for example, from the Responses API or a provider),
 * it is forwarded in `httpStatusCode` on the relevant `codexErrorInfo` variant.
 */
export type CodexErrorInfo =
  | "contextWindowExceeded"
  | "sessionBudgetExceeded"
  | "usageLimitExceeded"
  | "rateLimitExceeded"
  | "serverOverloaded"
  | "cyberPolicy"
  | "misalignmentPolicyViolation"
  | { httpConnectionFailed: { httpStatusCode: number | null } }
  | { responseStreamConnectionFailed: { httpStatusCode: number | null } }
  | "internalServerError"
  | "unauthorized"
  | "badRequest"
  | "threadRollbackFailed"
  | "sandboxError"
  | { responseStreamDisconnected: { httpStatusCode: number | null } }
  | { responseTooManyFailedAttempts: { httpStatusCode: number | null } }
  | { activeTurnNotSteerable: { turnKind: NonSteerableTurnKind } }
  | "other";

export type MisalignmentSteer = { message: string };

export type MisalignmentErrorDetails = {
  /**
   * Open-ended classification; clients must accept categories added by Responses.
   */
  errorType: string | null;
  /**
   * A substantive localized explanation is required before offering continuation.
   */
  detailedExplanation: string | null;
  /**
   * Instruction to submit as the next turn's user input if continuation is confirmed.
   */
  steer: MisalignmentSteer | null;
};

export type TurnError = {
  message: string;
  codexErrorInfo: CodexErrorInfo | null;
  additionalDetails: string | null;
  /**
   * Optional public explanation and continuation instruction for a misalignment block.
   */
  misalignment: MisalignmentErrorDetails | null;
};

export type TurnItemsView = "notLoaded" | "summary" | "full";

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export type Turn = {
  /**
   * Identifier for this turn. Codex-generated turn IDs are UUIDv7.
   */
  id: string;
  /**
   * Thread items currently included in this turn payload.
   */
  items: Array<ThreadItem>;
  /**
   * Describes how much of `items` has been loaded for this turn.
   */
  itemsView: TurnItemsView;
  status: TurnStatus;
  /**
   * Only populated when the Turn's status is failed.
   */
  error: TurnError | null;
  /**
   * Unix timestamp (in seconds) when the turn started.
   */
  startedAt: number | null;
  /**
   * Unix timestamp (in seconds) when the turn completed.
   */
  completedAt: number | null;
  /**
   * Duration between turn start and completion in milliseconds, if known.
   */
  durationMs: number | null;
};

export type Thread = {
  /**
   * Identifier for this thread. Codex-generated thread IDs are UUIDv7.
   */
  id: string; /**
   * Session id shared by threads that belong to the same session tree.
   */
  sessionId: string; /**
   * Source thread id when this thread was created by forking another thread.
   */
  forkedFromId: string | null; /**
   * The ID of the parent thread. This will only be set if this thread is a subagent.
   */
  parentThreadId: string | null; /**
   * Usually the first user message in the thread, if available.
   */
  preview: string; /**
   * Whether the thread is ephemeral and should not be materialized on disk.
   */
  ephemeral: boolean; /**
   * The independently persisted section selected for this thread, if any.
   */
  section: ThreadSection | null; /**
   * Unix timestamp in seconds when the thread entered its current section.
   */
  sectionEnteredAt: number | null; /**
   * Canonical project assignment owned by app-server, if any.
   */
  projectId: string | null; /**
   * Persisted thread history contract selected when this thread was created.
   */
  historyMode: ThreadHistoryMode; /**
   * Model provider used for this thread (for example, 'openai').
   */
  modelProvider: string; /**
   * Current configured model when loaded, otherwise the latest persisted model.
   * Null when unavailable. This is not per-turn execution telemetry.
   */
  model: string | null; /**
   * Current configured reasoning effort when loaded, otherwise the latest persisted effort.
   * Null when unset or unavailable. This is not per-turn execution telemetry.
   */
  reasoningEffort: ReasoningEffort | null; /**
   * Unix timestamp (in seconds) when the thread was created.
   */
  createdAt: number; /**
   * Unix timestamp (in seconds) when the thread was last updated.
   */
  updatedAt: number; /**
   * Unix timestamp (in seconds) used for thread recency ordering.
   */
  recencyAt: number | null; /**
   * Current runtime status for the thread.
   */
  status: ThreadStatus; /**
   * [UNSTABLE] Path to the thread on disk.
   */
  path: string | null; /**
   * Working directory captured for the thread.
   */
  cwd: AbsolutePathBuf; /**
   * Version of the CLI that created the thread.
   */
  cliVersion: string; /**
   * Originator recorded when the thread was created, independent of its current client or executor.
   * Null when the recorded originator is unavailable.
   */
  originator: string | null; /**
   * Origin of the thread (CLI, VSCode, codex exec, codex app-server, etc.).
   */
  source: SessionSource; /**
   * Optional analytics source classification for this thread.
   */
  threadSource: ThreadSource | null; /**
   * Optional random unique nickname assigned to an AgentControl-spawned sub-agent.
   */
  agentNickname: string | null; /**
   * Optional role (agent_role) assigned to an AgentControl-spawned sub-agent.
   */
  agentRole: string | null; /**
   * Optional Git metadata captured when the thread was created.
   */
  gitInfo: GitInfo | null; /**
   * Optional user-facing thread title.
   */
  name: string | null; /**
   * Only populated on `thread/resume`, `thread/rollback`, `thread/fork`, and `thread/read`
   * (when `includeTurns` is true) responses.
   * For all other responses and notifications returning a Thread,
   * the turns field will be an empty list.
   */
  turns: Array<Turn>;
};

export type ItemStartedNotification = {
  item: ThreadItem;
  threadId: string;
  turnId: string;
  /**
   * Unix timestamp (in milliseconds) when this item lifecycle started.
   */
  startedAtMs: number;
};

export type ItemCompletedNotification = {
  item: ThreadItem;
  threadId: string;
  turnId: string;
  /**
   * Unix timestamp (in milliseconds) when this item lifecycle completed.
   */
  completedAtMs: number;
};

export type AgentMessageDeltaNotification = {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
};

export type TurnStartedNotification = { threadId: string; turn: Turn };

export type TurnCompletedNotification = { threadId: string; turn: Turn };
