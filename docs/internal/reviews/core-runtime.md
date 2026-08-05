# Core runtime review

## Verdict

This is well above average code, with one genuinely unusual strength: the comments explain *why*, not *what*, and every hard-won provider quirk is documented at the line that encodes it. The test suite is real — `bun test` gives `312 pass, 17 skip, 0 fail`, and the migration tests build old schemas by hand and reopen them, so they can actually fail. The single biggest structural problem is `store.ts`: 326 of its 1390 lines are schema and migration work unrelated to the six repositories sharing the file, and because those lines are entirely private the seam costs nothing to cut. The most expensive *runtime* problem is smaller and less visible: `TaskWaiter`'s 100 ms poll materialises every full task row — prompt, shipped prompt, output, and a `JSON.parse` of the attempt history — ten times a second per waiter, purely to read `task.state`. Nothing here needs a rewrite, and the agent-interaction machinery inside `runTask` should be left alone.

## Findings

### 1. `TaskWaiter` re-reads and re-parses every full task row ten times a second — High
**Where:** `src/task-waiter.ts:88-113` and `src/task-waiter.ts:116-122`, against `src/store.ts:630-635`
**Problem:** `onChange` is invoked by `setInterval(..., 100)` (line 106) and by every `notify`. On each invocation it calls `this.tasks(ids)` (line 91), which calls `getTask(id)` per id — and `getTask` selects `TASK_COLUMNS` (`store.ts:60-63`), i.e. `prompt`, `shipped_prompt`, `output`, `attempts_json`, `scope_json`, `completion_json`, then runs `taskFromRow`, which `JSON.parse`s the scope, the completion, and the whole attempt array (`store.ts:1300`, `1308-1313`). All of that is thrown away unless `needsAttention` is true. The only fields the tick actually reads are `task.state` (line 94, via `needsAttention`) and the cursor (line 92).

Sizes are on record: the response-payload audit measures `shippedPrompt` at ~8,000 chars average and 35,405 peak, and `attempts` holds up to `MAX_ATTEMPTS = 10` prior worker outputs. `wait` accepts up to 8 task ids (`cli.ts:414`). A single 30-second `wait` on 8 tasks is therefore 2,400 full-row reads and 2,400 attempt-array parses to answer a question about eight enum values.
**Why it matters:** This is the hottest loop in the broker and it scales with prompt size rather than with task count, which is the wrong axis. It is also invisible: nothing in the code says the poll is heavy, so the next person who adds a column to `tasks` makes it worse without knowing.
**Fix:** Give the waiter a cheap state probe and materialise full tasks only at the moment it finishes. Add to `StateStore`:

```ts
taskStates(ids: string[]): Map<string, TaskState> {
  const placeholders = ids.map(() => "?").join(",");
  return new Map(this.database.query<{ id: string; state: TaskState }, string[]>(
    `SELECT id, state FROM tasks WHERE id IN (${placeholders})`,
  ).all(...ids).map(({ id, state }) => [id, state]));
}
```

then in `TaskWaiter`, take it as a third constructor argument alongside `getCursor` and rewrite `onChange`'s hot path:

```ts
const states = this.getStates(ids);           // one query, two columns
for (const id of ids) if (!states.has(id)) throw new Error(`unknown task: ${id}`);
const attention = ids.some((id) => needsAttention(states.get(id)!));
if (!attention && !(until === "progress" && latest > baseline)) return;
const tasks = this.tasks(ids);                // only now pay for the full rows
finish({ reason: attention ? "attention" : "progress", tasks, cursor });
```

`needsAttention` takes a `TaskState` instead of a `Task` — see finding 3, which wants that signature anyway. The unknown-id throw is preserved deliberately: `task-waiter.test.ts:122` asserts it.
**Risk:** behavior-adjacent — the decision inputs are identical, but the constructor gains a parameter and the throw for an unknown id moves from `tasks()` to the probe. `tests/task-waiter.test.ts` constructs `TaskWaiter` directly and would need the third argument.
**Effort:** M

### 2. `store.ts` is six repositories plus a schema engine in one file — High
**Where:** `src/store.ts:860-1185` (schema), `src/store.ts:1235-1390` (row mappers)
**Problem:** `StateStore` owns profiles, scope grants, memories, tasks, task events, and profile failures — that part is defensible; they share one connection and one `transaction` helper. What does not belong is the 326-line schema engine wedged into the middle: `configure` (860), `migrate` (867-1051), `backfillTaskSessionIds` (1053-1078), `widenProviderCheck` (1083-1122), `migrateTaskContract` (1124-1185). `migrate` alone is 185 lines of DDL, `PRAGMA table_info` probing, a column drop, and eight near-identical `INSERT OR IGNORE INTO schema_migrations` calls (1012-1039). Two of those methods duplicate the same `PRAGMA foreign_keys = OFF` / `BEGIN IMMEDIATE` / try / `COMMIT` / `ROLLBACK` / `finally` table-rebuild dance (1088-1121 and 1125-1184) without using the class's own `transaction` helper.
**Why it matters:** Schema changes and query changes are independent reasons to change. Today a one-line query edit means opening the same file as a 60-line table rebuild that can lose data if mishandled, and anyone reading `store.ts` to answer "what does `listTaskSummaries` return" scrolls past 320 lines that cannot answer it.
**Fix:** Move the schema work to `src/store/schema.ts` as free functions over a `Database`:

```ts
export function configureDatabase(db: Database): void
export function migrateDatabase(db: Database): { needsSessionBackfill: boolean }
function rebuildTable(db: Database, sql: string): void  // owns the OFF/BEGIN/COMMIT/ROLLBACK dance
```

`backfillTaskSessionIds` stays on the class — it is the one migration step that needs `captureTaskSessionId` — so the constructor becomes:

```ts
configureDatabase(this.database);
if (migrateDatabase(this.database).needsSessionBackfill) this.backfillTaskSessionIds();
```

Then move the row mappers (`profileFromRow`, `taskFromRow`, `scopeGrantFromRow`, `taskSummaryFromRow`, `taskEventFromRow`, `memoryFromRow`, and the row interfaces) to `src/store/rows.ts`. Every one is already a module-private free function, so nothing outside the file changes. `StateStore` lands at roughly 600 lines of queries.
**Risk:** none — the extracted code is entirely private and the public surface is untouched. Migration *behaviour* must be preserved verbatim, including the migration-5 backfill guard at 1041-1050 and the re-read of `PRAGMA table_info(tasks)` at 963-966 that exists because `migrateTaskContract` rebuilds the table without newer columns.
**Effort:** M

### 3. The lifecycle state sets are written out four times, and the TS and Swift definitions already disagree — High
**Where:** `src/task-waiter.ts:125-128`, `src/public-task.ts:174-177`, `src/tasks.ts:1016-1019`, `swift/Sources/DesignSystem.swift:209-211`
**Problem:** The same five-state set — `needs_input`, `blocked`, `completed`, `failed`, `cancelled` — is spelled out three times in TypeScript under three different names:

```ts
// task-waiter.ts:125
function needsAttention(task: Task): boolean {
  return task.state === "needs_input" || task.state === "blocked" ||
    task.state === "completed" || task.state === "failed" || task.state === "cancelled";
}
```
```ts
// public-task.ts:174
function settled(state: TaskState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled" ||
    state === "blocked" || state === "needs_input";
}
```
```ts
// tasks.ts:1016 — inline, inside update()
if (
  task.state === "needs_input" || task.state === "blocked" ||
  task.state === "completed" || task.state === "failed" || task.state === "cancelled"
) {
  taskWaiter.notify(task.id);
}
```

The Swift equivalent is a different set:

```swift
// DesignSystem.swift:209
var isTerminal: Bool {
    [.needsInput, .answered, .blocked, .completed, .failed, .cancelled].contains(self)
}
```

Swift counts `answered` as terminal; TypeScript does not. That difference is currently inert only because no code path ever writes the `answered` state (see finding 16) — it is a latent disagreement, not a live bug.

The resumable set is further along the same road. `failed, cancelled, blocked` is now written out five times: as a TypeScript array at `store.ts:528`, `store.ts:590`, and the shared `RESUMABLE_STATES` const at `tasks.ts:784`, and as SQL at `store.ts:540` and `store.ts:603`. Three of those six arrived with `handoffTask`, which copied `resumeTask`'s guard rather than sharing it — the duplication is not historical, it is actively reproducing.
**Why it matters:** Three copies of one predicate is three places to edit and two places to forget. The rule "a task in one of these states wakes every waiter" is load-bearing for `wait`, and it is currently discoverable only by reading three unrelated files.
**Fix:** Put the sets next to the type they constrain, in `types.ts`:

```ts
export const SETTLED_STATES = ["needs_input", "blocked", "completed", "failed", "cancelled"] as const;
export const RESUMABLE_STATES = ["failed", "cancelled", "blocked"] as const;
export function isSettled(state: TaskState): boolean {
  return (SETTLED_STATES as readonly string[]).includes(state);
}
```

`needsAttention(task)` becomes `isSettled(task.state)`, `settled` in `public-task.ts` is deleted for `isSettled`, `tasks.ts:1016` becomes `if (isSettled(task.state))`, and the four resumable arrays (`store.ts:528`, `store.ts:590`, `tasks.ts:784`, `tasks.ts:784`) all read `RESUMABLE_STATES`. Leave the three SQL literals (`store.ts:425`, `540`, `603`) as SQL — do not generate `IN` clauses from the constants. The string is clearer, and the `CHECK(state IN (…))` constraints at `store.ts:898` and `1136` already pin the same vocabulary at the schema level, so a mismatch surfaces as a constraint failure rather than silently.
**Risk:** none in TypeScript — same predicate, same states, verified against `tests/task-waiter.test.ts` and `tests/public-task.test.ts`. Leave the Swift enum alone in this pass; just make the TS side single-sourced so the drift becomes a one-line comparison.
**Effort:** S

### 4. `TaskField` resolves to `string`, so the `fields` contract type-checks nothing — High
**Where:** `src/public-task.ts:15-16`, `src/public-task.ts:48-50`, `src/cli.ts:66-69` — LIKELY FIXED: verify before working this finding
**Problem:**

```ts
export const TASK_FIELD_KEYS = [...Object.keys(TASK_FIELD_GROUPS), "all"] as const;
export type TaskField = (typeof TASK_FIELD_KEYS)[number];
```

`Object.keys` returns `string[]`, not the literal union. Spreading it into a tuple gives `readonly [...string[], "all"]`, so the indexed access `[number]` collapses to `string | "all"` — i.e. `string`. `TaskField` is `string`.

Confirmed by probe rather than by reading: the same shape compiled standalone under the project's own `strict` settings accepts `const bad: Field = "totally-not-a-field"` with no error. So `DEFAULT_INSPECT_FIELDS`, `DEFAULT_DELEGATE_FIELDS`, and every `fields` argument in `cli.ts` accept any string at compile time. The runtime is still safe — `z.enum(TASK_FIELD_KEYS)` builds from the values, and `taskView` line 49 falls back to `?? []` for unknown keys — but the compiler contributes nothing, and a typo like `"promptt"` in a default silently produces a narrower response than intended.

Two smaller casts exist only to paper over this: the `(TASK_FIELD_GROUPS as Record<string, readonly string[]>)` index at line 49, and the `(k): k is TaskField` predicate at `cli.ts:68`, which narrows `string` to `string`. Both delete once the type is real.

The second half of the same problem: `taskView` returns `Record<string, unknown>` (line 45). Every consumer in `cli.ts` spreads that into a response with no idea what is in it, so renaming a `Task` field drops it silently out of six MCP tool responses.
**Why it matters:** The `fields` selector is the response-payload contract for six MCP tools. It is exactly the surface that should be compiler-enforced, and it is the one place where it is not.
**Fix:** Derive the keys from the object type rather than from `Object.keys`:

```ts
export type TaskFieldGroup = keyof typeof TASK_FIELD_GROUPS;
export type TaskField = TaskFieldGroup | "all";
export const TASK_FIELD_KEYS = [
  ...(Object.keys(TASK_FIELD_GROUPS) as TaskFieldGroup[]), "all",
] as const satisfies readonly TaskField[];
```

`z.enum` needs a non-empty readonly string tuple; if `as const satisfies` does not satisfy it, spell all ten keys out literally — the nine groups plus `"all"` — and add `satisfies readonly TaskField[]` so the compiler catches a group added to `TASK_FIELD_GROUPS` but not to the list. Add the reverse guard too, so the group bodies cannot name a field `Task` does not have:

```ts
} as const satisfies Record<string, readonly (keyof Task)[]>;
```

That one clause is what stops `routing: ["profileId", "model", "efort"]` from compiling. Then give `taskView` a return type — `Partial<Omit<Task, "sessionId">> & { id: string; state: TaskState; attemptCount?: number }` describes exactly what it builds and is checked against the body for free.
**Risk:** none — types only, no runtime change. `tests/public-task.test.ts` already pins the floor key set, so a mistake here fails the suite.
**Effort:** S

### 5. `handoff` was built by copying `reply` and `resume` instead of sharing with them — High
**Where:** `src/tasks.ts:827-855`, `857-888`, `900-957`; `src/store.ts:513-563` vs `570-628` — LIKELY FIXED: verify before working this finding
**Problem:** The three continuation entry points now repeat the same four validation steps, and the newest one repeated them again rather than extracting them. `reply` (832-838) and `resumeTask` (862-868) contain a character-for-character identical block:

```ts
const config = await loadConfig();
const profile = config.profiles.find((item) => item.id === old.profileId);
if (!profile || !canResumeSession(profile)) {
  throw new Error(sessionResumeUnsupported(old.profileId, profile));
}
```

followed by a `!old.sessionId` throw that differs only in the verb — `"…to reply to: ${id}"` versus `"…to resume: ${id}"` (now a single `requireSessionProfile`, `tasks.ts:812-825`, taking the verb as its parameter). The `getTask` + `unknownTaskMessage` pair appears four times (832, 862, 905, 971). The resumable-state guard appears at 799. The replacement-scope line is identical at 851 and 923 apart from which profile id it names.

In the store the same story repeats one layer down: `resumeTask` (513-563) and `handoffTask` (570-628) are the same shape end to end — `current`-state probe, `closeAttempt`, an `UPDATE` whose first two lines (`SET state = 'queued', output = '', error = NULL, question = NULL, completion_json = NULL, attempts_json = ?`) are identical, the same `AND state IN ('failed', 'cancelled', 'blocked')`, the same `changes !== 1` throw, an `addTaskEvent`, and the same dead flag-and-rethrow epilogue from finding 8.
**Why it matters:** This is the clearest measurable signal in the review: the most recent feature in the repo grew the duplication rather than paying it down. The next continuation verb will copy `handoffTask`, and by then the "load a task and check it can continue" rule will live in four places with four slightly different error strings.
**Fix:** Extract the two genuinely shared preludes in `tasks.ts` — nothing in the store.

```ts
function requireTask(id: string): Task {
  const task = stateStore().getTask(id);
  if (!task) throw new Error(unknownTaskMessage(id));
  return task;
}

/** The profile a continuation will run on, proven able to reopen its session. */
async function requireSessionProfile(task: Task, verb: "reply to" | "resume"): Promise<Profile> {
  const profile = (await loadConfig()).profiles.find(({ id }) => id === task.profileId);
  if (!profile || !canResumeSession(profile)) {
    throw new Error(sessionResumeUnsupported(task.profileId, profile));
  }
  if (!task.sessionId) throw new Error(`task has no captured session to ${verb}: ${task.id}`);
  return profile;
}
```

`resumeTask`'s longer message ("the worker exited before the provider created a session; delegate a fresh task instead") is worth keeping, so pass the whole suffix rather than a verb if that reads better — but pass *something*, do not fork the function. `handoffTask` uses `requireTask` and the finding-3 `RESUMABLE_STATES` guard, and keeps its own profile lookup, which is legitimately different: it resolves the *destination* profile and checks `enabled`, not `canResumeSession`.

Deliberately **not** recommended: merging `store.resumeTask` and `store.handoffTask` into one parameterised writer. Their `SET` clauses diverge on five columns (`profile_id`, `model`, `effort`, `session_id`, `timeout_ms`, `allow_questions`), and two readable `UPDATE` statements beat one statement assembled from fragments. Fix findings 3 and 8 and what remains of the overlap is honest difference.
**Risk:** none — pure extraction of identical code. The error strings must come out byte-identical; `tests/task-lifecycle.integration.test.ts:163` matches on `/custom command; provider sessions are never captured/`.
**Effort:** M

### 6. The stdout line handler's `catch {}` swallows database failures, not just unparseable lines — High
**Where:** `src/tasks.ts:478-533`
**Problem:** The `try` opens at 478 around `JSON.parse(line)` (479) — which is the documented intent — but it closes at 533, around everything the handler does afterwards: `appendTaskEvent` (the SQLite write), `compactPayload`, `runCostFrom`, `writeTargetsFrom`, `scopeRefusedWrite`, `sessionIdFrom`, `captureTaskSessionId`, `killProcessGroup`, and the `lastAgentEventAt` / `eventCount` bookkeeping. A `SQLITE_BUSY` on the event insert, or a throw from any of those calls, is dropped with no record anywhere.

The failure mode is worse than a missing row. `lastAgentEventAt` is updated *inside* the swallowed block (line 489 in the parse path), so a persistent write failure also freezes the silence clock — and the heartbeat then reports the worker as stalled. The broker blames the provider for its own database problem.
**Why it matters:** This is the one place in the runtime where a real failure produces no signal at all: no event, no log line, no state change. From the outside it is indistinguishable from a quiet worker.
**Fix:** Narrow the `try` to the parse and let the rest throw:

```ts
let payload: Record<string, unknown>;
try {
  const parsed = JSON.parse(line) as unknown;
  payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown> : { value: parsed };
} catch { return; }
// …everything else, outside the catch
```
**Risk:** RISKY — core behavior. This is the provider stream loop, and the change is not neutral: today a throw from `appendTaskEvent` cannot kill a run, and narrowing the `try` means it can. Default to leaving it alone. If it is touched at all, the smaller version is to keep the block wide and emit one `event_handler_failed` event from the catch — that buys the diagnostic without changing what survives.
**Effort:** S

### 7. `listTaskSummaries` reads every heavy column it then throws away — Medium
**Where:** `src/store.ts:649-680`, `src/store.ts:1342-1345`
**Problem:** The summary query selects the full `TASK_COLUMNS` list (60-63) for up to 100 rows, then `taskSummaryFromRow` drops `shippedPrompt`, `output`, `attempts`, `scope`, `allowQuestions`, `timeoutMs`, `effort`, and `turns`. The comment at 1342-1344 claims the summary path avoids the parse cost:

```ts
// Builds the summary from the row directly. Going through taskFromRow would
// JSON.parse the full attempt history for every listed task only to discard it,
// and the app polls this list continuously.
function taskSummaryFromRow(row: TaskRow): TaskSummary {
  const task = taskFromRow({ ...row, attempts_json: null });
```

It does not build from the row directly — it calls `taskFromRow`, which still `JSON.parse`s `scope_json` (1300) and `completion_json` (1308) for every row, and `TaskSummary` has no `scope` field at all. Only the attempt array is skipped. The SQL still transfers `prompt`, `shipped_prompt`, and `output` off disk regardless, and the audited figures put `shipped_prompt` at ~8,000 chars average with `MAX_OUTPUT` at 10 MB.
**Why it matters:** A `tasks` call with `limit: 100` can read a megabyte of text to produce a list of 240-character previews. And the comment asserting otherwise is worse than no comment: it tells the next reader this path is already optimised.
**Fix:** Add a narrow column list and a mapper that reads the row directly, as the comment claims:

```ts
const TASK_SUMMARY_COLUMNS = `id, profile_id, model, prompt, cwd, state, error, question,
  parent_task_id, grant_id, tldr, title, session_id, completion_json, cost_usd,
  archived_at, created_at, updated_at`;
```

Keep `prompt` — `promptPreview` needs it, and `substr(prompt, 1, N)` is not provably identical once `\s+` collapsing is applied to the result. Dropping only `shipped_prompt`, `output`, `attempts_json`, `scope_json`, `allow_questions`, `timeout_ms`, `effort`, and `turns` is exactly behaviour-preserving and captures the bulk of the win. Then correct the comment to describe what the code does.
**Risk:** none — `TaskSummary`'s shape does not change. `tests/store.test.ts` already asserts summaries carry no `output` and no `attempts`.
**Effort:** S

### 8. Three store methods carry an unreachable failure path — Medium
**Where:** `src/store.ts:434-470` (`answerTask`), `513-563` (`resumeTask`), `570-628` (`handoffTask`)
**Problem:** All three follow this shape:

```ts
let resumed = false;
this.transaction(() => {
  …
  if (changed.changes !== 1) throw new Error(`task cannot be resumed: ${id}`);
  …
  resumed = true;
});
const task = resumed ? this.getTask(id) : undefined;
if (!task) throw new Error(`unknown task: ${id}`);
return task;
```

`transaction` (1223) rolls back and rethrows, so control only reaches the line after it when the callback ran to completion — meaning the flag is always `true` there, because setting it is the callback's last statement. And `getTask` cannot return `undefined` for a row a committed transaction just updated. The flag, the ternary, and the `unknown task` throw are all dead in all three methods. `setTaskArchived` already does the correct thing 60 lines away: `return this.getTask(id)!` (694).
**Why it matters:** Dead guards teach the next reader the case is reachable, so they preserve it — which is exactly how it got copied into `handoffTask`. Three near-identical dead epilogues is also most of what makes `resumeTask` and `handoffTask` look like duplicates (finding 5).
**Fix:** Delete the flag, the ternary, and the trailing throw in all three; end each with `return this.getTask(id)!`.

Note the contrast, and preserve it: `saveTask`, `cancelTask`, and `captureTaskSessionId` *return early* from the callback instead of throwing, so there the flag genuinely distinguishes "no row matched" from "committed" and must stay.
**Risk:** none — the thrown messages the tests assert on (`"does not need input"`, `"task cannot be resumed"`) are raised inside the transaction and are unaffected.
**Effort:** S

### 9. `taskEventView` is two functions in one, and its lifecycle branch is now a nine-level ternary — Medium
**Where:** `src/events.ts:50-206`, and specifically `62-81`
**Problem:** 157 lines. Lines 58-92 handle broker events and `return`; 94-205 handle provider agent events. The two halves share only `base` and `rawText` — the `return` at 82-91 and the `}` that closes the branch at 92 are already the split line, it is just not named.

Inside the first half, one expression computes the detail for eight event types through nested ternaries, and `handoff` just added two more arms to it:

```ts
const detail = event.type === "session_captured" ? "…"
  : event.type === "handed_off" ? "…"
  : event.type === "handoff_brief" ? joinDetail(…)
  : dropped ?? (event.payload.stalled === true ? "…"
    : event.type === "heartbeat" ? "…"
      : event.type === "needs_input" ? "…"
        : event.type === "answered" ? "…"
          : firstString(event.payload.provider, event.payload.model));
```

Note the shape: three arms indent left, then `dropped ??` re-nests and four more arms indent right. The `dropped` variable is computed separately at 59-61 and then consumed *in the middle* of the chain, so reading it requires holding two branch structures at once. The second half is a twelve-arm `if (subjectType.includes(...))` chain where order is load-bearing and undocumented.
**Why it matters:** Every new event type widens a single expression that is already at the limit of what anyone can read, and the fall-through ordering in the second half is a trap for anyone inserting a case in the wrong place. This is the second file where the newest feature made an existing problem measurably worse.
**Fix:** Split at the line that already returns, and flatten the chain into guard clauses:

```ts
export function taskEventView(event: TaskEvent, provider: Profile["provider"]): TaskEventView {
  const base = { id: event.id, taskId: event.taskId,
    source: event.type.startsWith("agent.") ? provider : "broker" as const,
    createdAt: event.createdAt };
  const rawText = Object.keys(event.payload).length
    ? JSON.stringify(event.payload, null, 2) : undefined;
  return event.type.startsWith("agent.")
    ? agentEventView(base, event.payload, rawText)
    : brokerEventView(base, event, rawText);
}

function lifecycleDetail(event: TaskEvent, dropped?: string): string | undefined {
  const p = event.payload;
  if (event.type === "session_captured") return "Root provider session mapped";
  if (event.type === "handed_off") return `${string(p.fromProfile) ?? "?"} → ${string(p.toProfile) ?? "?"}`;
  if (event.type === "handoff_brief") return joinDetail(…);
  if (dropped) return dropped;
  if (p.stalled === true) return `No agent event for ${…}s`;
  if (event.type === "heartbeat") return `Running for ${…}s`;
  …
  return firstString(p.provider, p.model);
}
```

One `if`/`return` per case, same order, same results, and the next event type is a one-line addition instead of a re-indentation.
**Risk:** none — mechanical. `tests/events.test.ts` has 40+ cases across all five providers covering both halves, including the two new handoff rows.
**Effort:** M

### 10. `events.ts` types every provider payload as `Record<string, any>` — Medium
**Where:** `src/events.ts:771-773`, `src/events.ts:213`, and every call site of `object()`
**Problem:** `TaskEvent.payload` is honestly `Record<string, unknown>` (`store.ts:81`), and that honesty is discarded the moment it enters `knownAgentEvent` (213, parameter typed `Record<string, any>`) or `object()`:

```ts
function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
```

From there every `payload.x`, `subject.y`, `state.z`, and `usage.input_tokens` access is unchecked — in the one file whose entire job is reading untrusted third-party JSON. The missing counterpart to `string()` (775) is why the same three-line shape is written **25 times** (`grep -c 'typeof .* === "number"'`):

```ts
...(typeof usage.output_tokens === "number" ? { tokensOut: usage.output_tokens } : {}),
```
**Why it matters:** A typo in a payload key — `output_tokens` against `outputTokens` — compiles, ships, and renders a blank row. That is precisely the class of bug this file exists to prevent, and `strict` is already on everywhere else in the project.
**Fix:** Add the missing helper, then narrow the two return types:

```ts
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
```

Rewrite the 25 sites through it — a small `counts(pairs)` builder that skips `undefined` values removes the repetition entirely. With arithmetic pushed behind `number()`, `object()` can return `Record<string, unknown>` and the compiler starts earning its keep. `Number.isFinite` also fixes a latent hole: a provider sending `NaN` currently passes `typeof === "number"` and lands in the presentation.
**Risk:** none behaviourally, with one exception worth checking — the `NaN` case above is a real (if unlikely) change. Do the conversion in one pass; a half-converted file carrying both idioms is worse than either.
**Effort:** M

### 11. `runTask`'s failure path re-reads the task row five times and the event log three times — Medium
**Where:** `src/tasks.ts:549, 559, 566, 576, 618` and `src/tasks.ts:674, 690, 929`
**Problem:** Two patterns, one cause. Five sites answer a single boolean with a full row read:

```ts
stateStore().getTask(task.id)?.state !== "cancelled"
```

`getTask` selects every column and `JSON.parse`s the scope, the completion, and up to ten attempt bodies (`store.ts:630-635`, `1285-1318`) — to compare one string. This is the same waste finding 1 identifies in the poll loop, on a different path.

Then on the failure path, `withScopeSuggestion` (674) and `lastWorkerErrorDetail` (690) run back to back and each calls `listTaskEvents(task.id)` — default limit 5,001 — so the whole event history is read and parsed twice. `handoffTask` makes a third such read at 929. And `withScopeSuggestion` does this:

```ts
const payloads = stateStore().listTaskEvents(task.id)
  .map((event) => JSON.stringify(event.payload));
```

`listTaskEvents` already `JSON.parse`d each payload (712-720); this stringifies them straight back so `deniedScopePaths` can take `string[]`. A parse-then-stringify round trip over the full history, per failed task.
**Why it matters:** It reads as if nobody has a cost model for one line, which invites more of the same — and a long reply/resume/handoff chain is exactly where the event count gets large.
**Fix:** The state probe from finding 1 (`taskStates`, or a single-id `taskState`) serves all five call sites; swap them. For the event log, hoist one `listTaskEvents` call in `runTask` and pass the array to both helpers, and change `deniedScopePaths` (`prompt-paths.ts`) to accept `Record<string, unknown>[]` so the round trip disappears.
**Risk:** behavior-adjacent. The state-probe swap is a pure narrowing of an existing read. Sharing one event array between the two helpers is safe only because neither mutates it and both run in the same synchronous stretch — confirm that before applying, and note `scopeInheritanceWarning` (216) now does `[...listTaskEvents(id)].reverse()`, so it copies before reversing and must keep doing so if it ever shares the array.
**Effort:** M

### 12. `store.ts` duplicates the task-event mapper and three row-type literals — Medium
**Where:** `src/store.ts:712-720` against `1374-1390`; type literals at `698-705`, `731-738`, `1374-1381`; memory literals at `275-277`, `284-286`, `1235-1237`
**Problem:** `listTaskEvents` maps its rows inline:

```ts
return rows.map((row) => ({
  id: row.id, taskId: row.task_id, type: row.event_type, state: row.state,
  payload: JSON.parse(row.payload) as Record<string, unknown>, createdAt: row.created_at,
}));
```

`taskEventFromRow` (1374-1390) has a byte-identical body, and `listTaskEventsForTasks` already uses it (via `.map(taskEventFromRow)`). The row type is written out three times as an inline structural literal — 698-705, 731-738, and as `taskEventFromRow`'s parameter at 1374-1381:

```ts
{ id: number; task_id: string; event_type: string; state: TaskState; payload: string; created_at: string }
```

The memory row type is written out three times the same way (275-277, 284-286, 1235-1237), while `TaskRow` (31) and `ScopeGrantRow` (1320) are properly declared once each — so the file already knows the right pattern and applies it inconsistently.
**Why it matters:** Six edit sites when a column is added, and no compiler help if one is missed: structural literals are independent, so they drift silently rather than failing to compile.
**Fix:** Declare `interface TaskEventRow` and `interface MemoryRow` next to `TaskRow` and `ScopeGrantRow`, use them at all six query sites, and replace `listTaskEvents`'s inline map with `.map(taskEventFromRow)`.
**Risk:** none.
**Effort:** S

### 13. `WaitTaskView` re-declares `TaskSummary`, and the 240-char preview rule exists twice — Medium
**Where:** `src/public-task.ts:115-138`, `src/public-task.ts:179-181`, `src/store.ts:1353`
**Problem:** `WaitTaskView` spells out 20 fields across 24 lines. Field for field, it is exactly:

```ts
export type WaitTaskView = Omit<TaskSummary, "sessionId">
  & { turns?: number; attemptCount?: number; output?: string };
```

Separately, the caller-visible truncation rule is written twice with no shared owner:

```ts
// public-task.ts:180
return prompt.replace(/\s+/g, " ").trim().slice(0, 240);
```
```ts
// store.ts:1353
promptPreview: task.prompt.replace(/\s+/g, " ").trim().slice(0, 240),
```
**Why it matters:** Two hand-maintained copies of one field list drift the first time a field is added to one of them, and the `wait` and `tasks` tools would then disagree about what a preview is.
**Fix:** Replace the `WaitTaskView` interface with the type alias above — it is structurally identical, so no call site changes. Export `preview` from `public-task.ts` and call it from `taskSummaryFromRow`; `store.ts` already imports from sibling modules, so the direction is fine.
**Risk:** none — `tests/public-task.test.ts` pins the emitted shape of `waitTaskView`, and the alias produces the same type.
**Effort:** S

### 14. `listScopeGrants` is unbounded and sits on the one-second poll path — Medium
**Where:** `src/store.ts:243-247`, called from `src/cli.ts:102`
**Problem:** No `LIMIT`:

```ts
listScopeGrants(): ScopeGrant[] {
  return this.database.query<ScopeGrantRow, []>(
    `SELECT ${GRANT_COLUMNS} FROM scope_grants ORDER BY last_used_at DESC, id DESC`,
  ).all().map(scopeGrantFromRow);
}
```

`GET /api/state` calls it on every request, and that route is polled every second by `src/channel.ts` and roughly every two seconds by the Swift app. Grants are only ever inserted (`recordScopeGrant`) or explicitly revoked (`revokeScopeGrant`) — nothing evicts them — so one row accumulates per distinct `(cwd, profile_id, scope_json)` for the life of the database, and `handoff` now creates them for a second profile on the same cwd. Every other list read in the file is bounded: `listTasks` at 200, `listTaskSummaries` at 100, `listTaskEvents` at 5,001.
**Why it matters:** It is the only query in the store whose cost grows without limit on a hot path, and it grows through ordinary use rather than through anything a user would recognise as accumulating state.
**Fix:** `ORDER BY last_used_at DESC, id DESC LIMIT 200`. The ordering is already newest-first, so truncation drops the least recently used grants, which is what the UI wants anyway. Return the total count alongside the rows so "these are all my grants" does not silently become false.
**Risk:** behavior-adjacent — the app's grant list caps at 200 rows. Worth confirming that ceiling is acceptable before applying, since revoking a grant you cannot see is not possible.
**Effort:** S

### 15. The lifecycle integration tests are the only coverage for reply, resume, handoff and cancel, and nothing in the repo runs them — Medium
**Where:** `tests/task-lifecycle.integration.test.ts:17`, `tests/task-scope.test.ts:212`
**Problem:** `const integrationTest = process.env.INTER_SANDBOX_INTEGRATION === "1" ? test : test.skip;`

The gate itself is justified — every spawn goes through `sandboxedCommand`, which does not work nested inside another sandbox. But nothing sets the variable: not `package.json`, not the `Makefile`, not the README. The only other mention anywhere in the repo is `examples/incident-room/AGENT-NOTES.md`. So `bun test` reports `312 pass, 17 skip`, and those 17 — 12 lifecycle plus 5 scope — are the only coverage that exists for cancel, timeout, reply, resume, `resume_session_mismatch`, `resume_failed`, the Antigravity bootstrap retry, and the `PWD` guarantee. In the default suite, `runTask`'s only exercised path is the `command: ["true"]` noop in `tests/tasks.test.ts`.
**Why it matters:** The most intricate ~270 lines in the codebase have coverage nobody is going to remember to invoke, and `handoff` has just been added on top of them. A named script is the difference between "gated" and "abandoned".
**Fix:** Add `"test:integration": "INTER_SANDBOX_INTEGRATION=1 bun test"` to `package.json` scripts, and one line in the README saying when to run it and why it is gated. Separately, some of what is currently gated needs no sandbox at all: the precondition errors in `reply` (832-838), `resumeTask` (862-868), and `handoffTask` (905-914) — unknown task, wrong state, same-profile handoff, disabled profile, missing session — are pure guard logic reachable through a `command` profile, and belong in the default suite. `handoffTask`'s "already on that profile" error (906-910) has no test at all.
**Risk:** none.
**Effort:** S

### 16. `"answered"` is a task state no code path can produce — Low
**Where:** `src/types.ts:14`, `src/store.ts:898` and `1136`, `src/tasks.ts:1000`, `src/cli.ts:48`
**Problem:** `answerTask` writes `state = 'queued'` (`store.ts:444`) and passes `"answered"` only as the *event type*, with `"queued"` as the state. Nothing anywhere assigns `state = "answered"`. So the ladder arm at `tasks.ts:1000` is unreachable:

```ts
: task.state === "answered" ? "answered"
```

both `CHECK(state IN (…))` constraints permit a value no writer writes, `cli.ts:48` exposes it as a queryable filter that can never match, and `TaskState` models a state the machine does not have. The only thing keeping it alive is `tests/task-waiter.test.ts`, which constructs the state by hand. It is also the exact state Swift's `isTerminal` counts and TypeScript's predicates do not (finding 3).
**Why it matters:** A union that permits an impossible state means every `switch` over it grows a branch nobody can reach through the real API — and it is already the source of one live TS/Swift disagreement.
**Fix:** Decide, do not drift. Either remove `"answered"` from `TaskState`, both `CHECK` constraints, `cli.ts:48`, `tasks.ts:1000`, and the Swift enum together; or keep it and write one comment on `types.ts:14` saying it is reserved and why, then delete the unreachable ladder arm regardless.
**Risk:** behavior-adjacent for the removal — the `CHECK` constraint is in a live schema and Swift decodes the string, so both sides must land together. The comment-only option carries no risk.
**Effort:** S

### 17. `TaskWaiter.wait` writes its wake decision twice — Low
**Where:** `src/task-waiter.ts:58-63` and `88-112`
**Problem:** The pre-check at 58-63 and the `onChange` body at 94-95 encode the same two decisions — attention wins, then progress past the cursor — and `onChange()` is then invoked synchronously at 112, so both code paths evaluate on every call. The cursor expression `Math.max(afterCursor ?? 0, this.getCursor(ids))` appears three times: as the `cursor()` closure at 57, inline at 93, and inline again at 110.
**Why it matters:** A change to the wake rule has to be made in two places that look different enough to miss one, and finding 1 wants to change exactly that rule.
**Fix:** One private method, called by both:

```ts
private decide(ids: string[], baseline: number, until: WaitUntil, afterCursor?: number): TaskWaitResult | undefined
```

Keep the pre-check as a fast path that avoids constructing the promise — just have it call `decide` rather than restate it. Do this before finding 1, not after: the state-probe change lands in one place instead of two.
**Risk:** none — `tests/task-waiter.test.ts` covers the immediate-return, timeout, progress, attention, and unknown-id paths.
**Effort:** S

### 18. `warningsFor` computes the inheritance warning twice — Low
**Where:** `src/cli.ts:569-570`
**Problem:**

```ts
const warnings = [
  ...(scopeInheritanceWarning(task) ? [scopeInheritanceWarning(task)!] : []),
  ...await policyWarnings(cwd, task),
];
```

Called once for the test and once for the value, with a `!` because the type system cannot connect the two calls. Each call reads the task's entire event list, copies the array, reverses it, and `JSON.parse`s every payload (`tasks.ts:216`).
**Fix:**

```ts
const inherited = scopeInheritanceWarning(task);
const warnings = [...(inherited ? [inherited] : []), ...await policyWarnings(cwd, task)];
```

The `!` disappears as a side effect, which is the tell that the original was working around itself.
**Risk:** none.
**Effort:** S

### 19. `publicTask` is a dead export kept alive only by its own test — Low
**Where:** `src/public-task.ts:29-32`, `tests/public-task.test.ts:62, 290-291` — LIKELY FIXED: verify before working this finding
**Problem:** No file in `src/` calls `publicTask`. Its sibling `publicTaskSummary` is live (`cli.ts`), and `publicAttempt` (33) is live inside `taskView`. The only references to `publicTask` are three assertions in `public-task.test.ts`, so the test suite is the sole reason it still exists — and "never emits `sessionId`" is already covered properly against `taskView`, which is what callers actually receive.
**Why it matters:** It is a second, unenforced answer to "what is safe to return to a caller", sitting next to the enforced one. The `fields` design deliberately replaced it; leaving it exported invites someone to use it and ship the whole `Task`.
**Fix:** Delete `publicTask`. Drop the assertion at 290-291 and rewrite line 62 (`publicTask(pollingTask()).shippedPrompt`) against `taskView(task, ["shippedPrompt"])`, which is the real path to that field.
**Risk:** none.
**Effort:** S

## Nits

- `src/tasks.ts:690` — the function body opens on the signature line: `): { error?: string; last?: string } {  const events = …`. A stray join with two spaces; move it to its own line.
- `src/store.ts:1303` — `...(row.timeout_ms ? { timeoutMs: row.timeout_ms } : {})` tests a number for truthiness, while `cost_usd` and `turns` twelve lines later correctly test `=== null` (1314-1315). Harmless today because `validateTimeoutMs` rejects `0`, but inconsistent inside one function.
- `src/store.ts:671` — `clauses.length > 0 ? … : ""` can never take the else branch: `archiveClause` is pushed unconditionally on line 670.
- `src/store.ts:1370` — `archiveClause` returns the literal `"1 = 1"` for `"include"`. "No filter" is better expressed as `undefined` and dropped in TypeScript than as a tautology handed to SQLite.
- `src/store.ts:1012-1039` — eight consecutive `INSERT OR IGNORE INTO schema_migrations` calls differing only in a version number and a name. One loop over a literal array of pairs.
- `src/store.ts:60-63` — `TASK_COLUMNS` carries the indentation of the call site it was extracted from *inside* the template literal, so every query built from it emits ragged SQL.
- `src/store.ts:748` — public `appendTaskEvent` is a one-line alias for private `addTaskEvent` (1216). Two verbs for one operation; keep the public name and rename the private one to match.
- `src/store.ts:121` — `try { chmodSync(this.path, 0o600); } catch {}` silently drops a failure to lock down the database file. This is the one swallowed catch in the file with a security consequence; one `console.warn` is enough.
- `src/task-protocol.ts:241` — `credits?error` reads like a typo. It is matching `CreditsError` with the separator absent. Five words of comment saves the next reader a double-take, or write it as `credits[ ]?error`.
- `src/events.ts:971-989` — `presentationDetail`'s switch has no arm for `"usage"` or `"signal"` and no `default`. Correct today only because the return type admits `undefined`; a new presentation type renders blank rather than failing to compile.
- `src/events.ts`, `src/types.ts`, `src/tasks.ts` and four others — 62 `///` doc comments, 39 of them in `events.ts`. That is Rust/Swift syntax; TypeScript tooling shows nothing on hover, and the same files use `/** */` elsewhere. Normalising is a find-and-replace that makes the comments visible where they are read.

## What is already good

Named specifically, so it is clear what not to touch:

- **`src/task-protocol.ts` is the best file in the set.** Pure functions, no I/O, a flat guard-clause ladder in `interpretWorkerOutcome`, and every regex carries the reason it is shaped the way it is. The note explaining why `COMPLETED` is line-anchored but *not* end-anchored is exactly the comment that stops someone "simplifying" it into a bug. It needs nothing.
- **The why-comments throughout.** `store.ts:65-67` (heartbeats must not advance the cursor), `store.ts:1080-1082` (a `CHECK` cannot be altered, so a table rebuild is the only fix), `tasks.ts` on pi's O(n²) payloads with the measured 827 KB, the per-variable justification of the worker `env` block, `events.ts` on "Reasoning" not "Thinking". This density of *why* is rare. Preserve every one of them through any refactor — and note the same discipline carried into `handoffTask`'s doc comment (890-899), which explains why a handoff cannot reuse a session at all.
- **Optimistic concurrency on the task row.** `saveTask`'s `expectedStates` guard, with a test proving a worker completion cannot overwrite a cancellation. The whole cancel-during-run race rests on this and it is correctly done.
- **The migration tests.** They build genuinely old schemas by hand — including the pre-`pi` `CHECK` constraint — and reopen them. These can fail, which is the only property that matters in a migration test.
- **The attempts ring buffer.** `MAX_ATTEMPTS` with `closeAttempt`, and a test that drives 14 runs and asserts *which end* got dropped.
- **Indexes match the hot queries.** `tasks_updated_at(updated_at DESC, id DESC)` matches every list's `ORDER BY`, and `task_events_task_id(task_id, id)` matches the cursor scan. Nothing to add at this data size.
- **Bun-native throughout.** `bun:sqlite`, `Bun.spawn`, `Bun.env`, `Bun.sleep`, `Bun.serve`; `node:*` appears only for `fs`/`path`/`os`, where Bun has no equivalent.
- **The `wait` cursor contract.** The comment about a cursor belonging to the id set that produced it, the `Math.max` that enforces it, and the MCP tool description that tells callers the same thing. Three places, one story.
- **`taskFromRow`'s absent-vs-empty discipline.** Optional fields are omitted rather than set to `undefined` or `""`, and the tests assert the distinction for `effort`, `tldr`, and `title` in both directions.
- **`databasePath`'s test guard** (`store.ts:1259-1270`): refusing to open the default broker database under `NODE_ENV=test`, with the comment explaining that a test reaching that path would migrate the developer's live database. That is a failure mode most projects discover the hard way.

## Suggested order of work

1. **Finding 3** — hoist `SETTLED_STATES` / `RESUMABLE_STATES` / `isSettled` into `types.ts`. Smallest change, largest correctness payoff, and it removes four of the six resumable-set copies that finding 5 also touches.
2. **Finding 17** — collapse `TaskWaiter`'s duplicated decision into one `decide`. Do this *before* finding 1 so the hot-path change lands in one place instead of two.
3. **Finding 1** — give the waiter a cheap state probe. Highest runtime payoff in the review; the `taskState` helper it adds is also what finding 11 needs.
4. **Finding 4** — make `TaskField` a real union and give `taskView` a return type. Turns the compiler back on over the response-payload contract before anything else edits it.
5. **Findings 8, 12, 13, 18, 19** and the nits — the zero-risk mechanical batch, one pass over `store.ts`, `public-task.ts`, and `cli.ts`. Finding 8 first within the batch: it removes most of what makes finding 5's store methods look alike.
6. **Finding 5** — extract `requireTask` and `requireSessionProfile` in `tasks.ts`. Now cheap, because steps 1 and 5 already removed the guard and the epilogue.
7. **Finding 2** — split `store/schema.ts` and `store/rows.ts`. After step 5, so the mappers move once, already cleaned.
8. **Findings 7 and 14** — the two data-layer fixes. Confirm the 200-grant ceiling with the user before applying 14.
9. **Findings 9 and 10** — `events.ts`, together and in one pass. Splitting `taskEventView` and introducing `number()` touch the same lines; doing them separately means reading the file twice.
10. **Finding 15** — add the `test:integration` script, then move the sandbox-independent precondition tests into the default suite. Worth doing before step 11 rather than after, since it is the only coverage the handoff guards will ever get.
11. **Finding 11** — swap the five cancellation re-reads onto the step-3 probe and share the event read.
12. **Findings 6 and 16** — decide, do not drift. Finding 6 is marked `RISKY — core behavior`: the recommendation is to leave the stream loop alone and accept the documented exposure, or take only the `event_handler_failed` half. Finding 16 has a zero-risk option (one comment) and a cross-language option (removal); pick one and close it.
