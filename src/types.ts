export type Provider = "claude" | "codex" | "opencode" | "antigravity" | "pi";
export type TaskState =
  | "queued"
  /**
   * Held: the broker knows when or on what condition this task starts, and it
   * is not before then. Survives restarts untouched — recovery names its states
   * explicitly and this is not one of them. Release moves it to `queued`.
   */
  | "pending"
  | "running"
  | "needs_input"
  /**
   * Unreachable: no writer produces it. `answerTask` sets the row back to
   * `queued` and records `answered` as the *event* type, so the state only ever
   * appears in an event log. Kept rather than removed because the string is
   * pinned outside this file — both `CHECK(state IN (…))` constraints in the
   * live schema and the Swift `TaskState` enum decode it — and those have to
   * land together with a migration.
   */
  | "answered"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskScope {
  read: string[];
  write: string[];
}

export type CompletionCode =
  | "completed"
  | "permission_denied"
  | "needs_authority"
  | "unverified"
  /** The provider's generation died mid-turn; distinct from finishing unsigned. */
  | "aborted"
  | "cancelled"
  | "timeout"
  | "auth"
  | "billing"
  | "rate_limit"
  /** The provider host could not be reached: dial/DNS/TLS/timeout, not a rejected credential. */
  | "network"
  | "worker_error";

/**
 * A caller's correction of a completion the worker never attested. The state
 * moves to `completed` but the original completion survives untouched, so an
 * asserted completion stays visibly different from a verified one forever.
 */
export interface TaskCompletionOverride {
  /** Who or what asserted the completion: the caller's own identity. */
  assertedBy: string;
  /** Why the work demonstrably landed despite the recorded outcome. Required, never empty. */
  reason: string;
  /** When the caller asserted it, ISO. */
  assertedAt: string;
  /** The completion code the override replaced, so the original verdict stays on the record. */
  replacedCode?: CompletionCode;
}

export interface TaskCompletion {
  exitCode?: number;
  blocked: boolean;
  code: CompletionCode;
  reason?: string;
  /** Scope that would have survived the run's sandbox denials; approve on resume. */
  suggestedScope?: TaskScope;
  /**
   * When the provider's rate-limit window clears, ISO. Only set on `rate_limit`.
   * The session on that account stays valid, so this is the caller's choice:
   * wait until then and `resume` for free, or `handoff` now to another profile.
   */
  resetsAt?: string;
  /**
   * Present only when the completion was asserted by a caller rather than
   * attested by the worker. It rides with `completion` instead of being an
   * opt-in surface field because a completion view without it would read an
   * asserted success as a verified one.
   */
  assertedCompletion?: TaskCompletionOverride;
}

export interface Profile {
  id: string;
  label: string;
  provider: Provider;
  model: string;
  enabled: boolean;
  env: Record<string, string>;
  capabilities: string[];
  command?: string[];
}

export type RoutePreference = "balanced" | "quality" | "cost" | "speed";
export type TaskClass = "mechanical" | "context" | "build" | "reasoning" | "general";

/**
 * How hard the caller judges the work to be. The one routing input the caller
 * knows better than Inter does: it wrote the prompt. Everything else — profile,
 * model, effort — is derived from this plus the project policy.
 */
export type Difficulty = "mechanical" | "standard" | "hard" | "critical";

/** Where a candidate fell out of selection. Ordered most-informative first. */
export type SelectionStage =
  /** Cleared every other filter but sits below the difficulty's capability tier. */
  | "floor"
  /** The account has effectively no quota left in its current window. */
  | "quota"
  /** A recorded auth, billing, or rate-limit failure on the account. */
  | "availability"
  /** The account's own catalog does not list the model. */
  | "catalog"
  /** Outside the allow list the project policy sets for this kind of work. */
  | "policy"
  /** No tool calling, or not a text model. */
  | "capability"
  | "profile";

export interface SelectionRejection {
  profileId: string;
  model: string;
  stage: SelectionStage;
  reason: string;
  retryAt?: string;
}

/**
 * Why a task landed on the profile, model, and effort it did. Recorded next to
 * the outcome so a good routing call and a lucky caller guess stay tellable
 * apart afterwards; `decidedBy` is the field that separates them.
 */
export interface TaskSelection {
  decidedBy: "router" | "caller-profile" | "caller-explicit";
  routerVersion: number;
  difficulty: Difficulty;
  difficultySource: "caller" | "default";
  /** What the prompt heuristic made of the work, kept as a check on the declaration. */
  heuristicClass: TaskClass;
  /** False when the heuristic wanted a stronger tier than the declared difficulty allows. */
  heuristicAgreed: boolean;
  floor: number;
  floorRelaxed: boolean;
  preference: RoutePreference;
  chosen: { profileId: string; model: string; effort?: string };
  effortSource: "caller" | "projected" | "none";
  effortReason: string;
  /**
   * Worst usage window on the chosen account, or null when its provider reports
   * no usage at all — which is unknown headroom, not full and not empty.
   */
  quotaUsedPercent: number | null;
  runnersUp?: Array<{ profileId: string; model: string }>;
  rejected?: SelectionRejection[];
  /** Total rejections, since `rejected` carries only the most informative few. */
  rejectedCount?: number;
  warnings?: string[];
}

/** A selection with the chosen pair still to be filled in from the task row. */
export type SelectionDecision = Omit<TaskSelection, "chosen">;

export interface Config {
  profiles: Profile[];
}

/** A scope the caller stated for a cwd, kept so later delegations can reuse it. */
export interface ScopeGrant {
  id: string;
  cwd: string;
  /** Profile the scope was stated for. Approval is per destination, not just per folder. */
  profileId: string;
  scope: TaskScope;
  createdAt: string;
  lastUsedAt: string;
  useCount: number;
}

/** What one worker run produced, kept when reply or resume starts the next run. */
export interface TaskAttempt {
  output: string;
  error?: string;
  question?: string;
  completion?: TaskCompletion;
  endedAt: string;
  /**
   * Where this run actually ran. The task row carries the current profile and
   * session, so after a handoff moves both, the attempt is the only record of
   * which account did the earlier work and which session holds it.
   */
  profileId?: string;
  sessionId?: string;
}

/**
 * Why a `pending` task has not started. One row per task; the sweep in
 * `src/holds.ts` is the only reader of `nextCheckAt`.
 */
export interface TaskHold {
  taskId: string;
  /** What release calls. v1 arms holds only from resume. */
  verb: "resume";
  /** Arguments release replays, currently the stored resume instruction. */
  args: { instruction?: string };
  /** Clock condition, ISO: not before this instant. */
  startAt?: string;
  /** Availability condition: hold until this profile+model is not unavailable. */
  awaitProfile?: string;
  awaitModel?: string;
  /** When the sweep should next evaluate this hold, ISO. */
  nextCheckAt: string;
  /** Give-up time, ISO. Past it the hold is dropped and the task lands blocked. */
  expiresAt: string;
  /** Releases that ran into a still-limited account and re-armed. Capped at 3. */
  probeCount: number;
  /** The one human line every surface shows, written at arm time. */
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEntry {
  cwd: string;
  key: string;
  value: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** One cwd's memory footprint, sized without loading the values themselves. */
export interface MemoryProject {
  cwd: string;
  count: number;
  chars: number;
  updatedAt: string;
}

/** A task's own checkout of its repository, when it was delegated with one. */
export interface TaskWorktree {
  /** The repository directory the caller delegated against. */
  originCwd: string;
  /** Root of the checkout the worker runs in. */
  path: string;
  /** Branch the worker commits on. It survives cleanup; the checkout does not. */
  branch: string;
}

export interface Task {
  id: string;
  profileId: string;
  model: string;
  prompt: string;
  /** The prompt actually sent to the worker: caller text plus memories and protocol wrapper. */
  shippedPrompt?: string;
  cwd: string;
  /**
   * Present when the run happens in a dedicated checkout instead of the
   * caller's directory. `cwd` is then inside that checkout, while everything
   * keyed to the project — grants, memories, config, the context map — stays on
   * {@link TaskWorktree.originCwd}.
   */
  worktree?: TaskWorktree;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  output: string;
  error?: string;
  question?: string;
  parentTaskId?: string;
  scope: TaskScope;
  /** Grant the scope came from; absent means the caller stated no scope and none was on file. */
  grantId?: string;
  allowQuestions: boolean;
  timeoutMs?: number;
  /** Reasoning effort requested for this run; persisted so resume reuses it. */
  effort?: string;
  /**
   * The reasoning level the provider session actually ran at, read back from
   * the session store after the run. Absent when the provider does not record
   * it (or no session was captured) — never guessed from the requested effort.
   */
  effortActual?: string;
  /** Caller's one-line handle for this task, what a human reads instead of the prompt. */
  tldr?: string;
  /** Short label for this task, what a sidebar reads at a glance. */
  title?: string;
  sessionId?: string;
  completion?: TaskCompletion;
  attempts?: TaskAttempt[];
  costUsd?: number;
  turns?: number;
  archivedAt?: string;
  /**
   * Follow-up instructions waiting to be fed into this session once the current
   * run lands clean. Counted on the single-task read only, so it is absent —
   * never zero — everywhere the list poll builds a task.
   */
  queuedFollowUps?: number;
}

export interface TaskSummary {
  id: string;
  profileId: string;
  model: string;
  cwd: string;
  state: TaskState;
  promptPreview: string;
  /** Caller's one-line handle for this task, shown in the app's task list. */
  tldr?: string;
  /** Short label for this task, shown in the app's sidebar. */
  title?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  question?: string;
  parentTaskId?: string;
  grantId?: string;
  sessionId?: string;
  completion?: TaskCompletion;
  costUsd?: number;
  archivedAt?: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  provider: Provider;
  profileId: string;
  source: "discovered" | "alias" | "configured";
  cost?: {
    input: number;
    output: number;
  };
  contextWindow?: number;
  reasoning?: boolean;
  /// Reasoning effort levels this model accepts, weakest first, as published by
  /// the provider. Undefined means the provider does not publish a ladder, not
  /// that the model has none.
  efforts?: string[];
  defaultEffort?: string;
  toolCall?: boolean;
}

/** One top-level declaration the context map knows about. */
export interface ContextSymbol {
  line: number;
  kind: "fn" | "class" | "type" | "const" | "struct" | "enum" | "ext" | "view";
  name: string;
  /** Parameter names only, `?` kept; absent when the declaration has none. */
  params?: string;
  /** Present only when the source declares a return type. */
  returns?: string;
  exported: boolean;
  /** Null until a describe pass or a worker correction wrote one. */
  purpose: string | null;
  /** False when the purpose came from a worker correction or a changed signature. */
  confirmed: boolean;
}

/** One mapped file's row in context_files. */
export interface ContextFile {
  cwd: string;
  path: string;
  lang: "ts" | "swift";
  purpose: string | null;
  lines: number;
  size: number;
  mtimeMs: number;
  digest: string;
  symbols: ContextSymbol[];
  status: "mapped" | "unparsed";
  touchCount: number;
  touchedAt: string | null;
  mappedAt: string;
  updatedAt: string;
}

/** One project's row in context_maps. */
export interface ContextMapRow {
  cwd: string;
  scheme: number;
  state: "building" | "ready" | "partial";
  builtAt: string | null;
  fileCount: number;
  symbolCount: number;
  pendingProse: number;
  updatedAt: string;
}

/** One cwd's map footprint, sized without loading the rows themselves. */
export interface ContextFileProject {
  cwd: string;
  fileCount: number;
  symbolCount: number;
  pendingProse: number;
  updatedAt: string;
}
