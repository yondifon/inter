# Surface and routing review

Reviewed 2026-08-03; line citations reconciled against the working tree on 2026-08-04. Targets: `src/cli.ts`, `src/adapters.ts`,
`src/model-router.ts`, `src/routing-policy.ts`, `src/models.ts`, `src/task-scope.ts`, `src/channel.ts`,
`src/usage.ts`, `src/profile-status.ts`, `src/profile-discovery.ts`, `src/profile-input.ts`,
`src/mcp-copy.ts`, `src/mcp-wait.ts`, `src/memories.ts`, `src/worker-path.ts`, `src/prompt-paths.ts`,
`src/config.ts`, `src/provider-defaults.ts`, plus their tests and their callers in `src/tasks.ts`,
`src/store.ts`, `src/task-protocol.ts` and `swift/Sources/ProfileStore.swift`.

**Checks not run.** No builds, per instruction. `bun test` was not run either: this review sandbox
cannot write to the system temp dir (`zsh: can't create temp file … operation not permitted`), and most
of the relevant suites `mkdtempSync` into it, so a run here would report sandbox failures rather than
code failures. Every finding below is derived by reading the exact lines cited. The one claim that
needed a runtime check — finding 7 — was verified with a throwaway `tsc --noEmit` probe under
`docs/reviews/`, since deleted.

**Coverage gap.** `src/cli.ts` and `src/public-task.ts` were edited after the first pass and every
citation below has been re-checked against the current files. Two sub-claims died in that recheck and
are marked inline (finding 7's `"all"` cast, now gone). One thing is genuinely **not reviewed**: the
`handoff` tool (`src/cli.ts:491-513`) landed after the reading pass, so the surface is 13 MCP tools, not
the 12 this review examined. Findings 1, 6 and 7 apply to it by construction — it shares the same
`result()`/`startedTask` path and the same unchecked `DEFAULT_HANDOFF_FIELDS` (`:63`) — but its own
contract has not been read line by line here.

## Verdict

The domain layer of this repo is better than most production TypeScript: `public-task.ts`,
`routing-policy.ts`, `worker-path.ts` and the `ChannelWatcher` are genuinely senior work — small, pure,
tested, and commented with *why* rather than *what*. The surface layer is where it falls off.
`src/cli.ts` is a single 620-line module that starts a listener at import time, so the entire HTTP and
MCP surface — 13 routes, 13 tool contracts — has zero test coverage, and it shows: five of the six
routes that read a request body return 500 on malformed JSON, seven copies of one catch block collapse
every failure to 400, and `POST /api/profiles` turns each of its own validation messages into an empty
500 that the macOS app renders as a generic failure. The single biggest structural problem is that
missing seam, because it is also what makes every other surface finding here cheap to fix and hard to
regress. It is worth fixing now, and it is a mechanical split: extract `handleRequest(request)` and
`createMcpServer()`, leave `Bun.serve` in a thin entry point, change no behavior. The agent-interaction
core (`adapters.ts` argv, session capture, the tool descriptions) is in good shape and this review
leaves it alone.

## Findings

### 1. `cli.ts` has no seam between transport and anything else, so the whole surface is untested — High

**Where:** `src/cli.ts:81-310` (server + routes), `src/cli.ts:312-314` (stdio), `src/cli.ts:316-564` (MCP wiring)

**Problem:** `Bun.serve({...})` runs as a top-level statement, so importing the module binds port 7331.
Nothing can import it in a test, and nothing does — `grep -rn "src/cli" tests/` returns no matches. One
module mixes seven concerns: process config (`:37`), the HTTP listener, route matching, body parsing,
business logic (`finalText` mapping at `:97`, profile patch semantics at `:198-214`, env masking at
`:608-616`), 13 MCP tool schemas, and warning composition (`:567-591`). The `fetch` handler is a
225-line if-chain of `url.pathname === …` plus five inline regexes.

**Why it matters:** Every route contract in the product — status codes, error bodies, the `fields`
defaults, the archive filter — is unverifiable, and the findings below exist because nothing catches
them. It also means the MCP tool wiring (which `fields` default each tool applies, whether `warnings`
rides delegate) can only be checked by hand against a live broker.

**Fix:** Three files, no behavior change:

```ts
// src/http.ts
export async function handleRequest(request: Request): Promise<Response> { /* today's fetch body */ }
// src/mcp-server.ts
export async function createMcpServer(): Promise<McpServer> { /* today's factory */ }
// src/cli.ts — entry point only
if (import.meta.main) {
  Bun.serve({ port, hostname: "127.0.0.1", idleTimeout: 255, fetch: handleRequest });
  if (process.argv.includes("--stdio")) serveStdio(() => createMcpServer());
}
```

Then split `handleRequest` by resource (`routes/tasks.ts`, `routes/profiles.ts`, `routes/state.ts`) with
a small matcher, and test each with a constructed `Request`. `mcpHandler` (`:76-79`) moves next to
`createMcpServer`.

**Risk:** none — pure relocation. The `--stdio` gate moving inside `import.meta.main` is the only
semantic change, and it is the intended one (importing the module must not serve).

**Effort:** M

### 2. `/api/state` re-runs `finalText` over output that is already final text — High

**Where:** `src/cli.ts:91-98` (the mapping is `:95-98`)

**Problem:** The handler maps every task through
`profile && task.output ? { ...task, output: finalText(profile, task.output) } : task`. But `task.output`
is *already* the parsed answer: `src/tasks.ts:585` computes `finalText(profile, stdout)` and passes
it into `interpretWorkerOutcome`, whose `outcome.output` is what `update()` persists (`src/tasks.ts:607-616`),
and `src/store.ts` only ever writes `task.output` or `''` (`:331, :398, :444, :534, :596`). So on every poll
this does a linear `profiles.find` per task plus a per-line `JSON.parse` scan of the whole output, for up
to 200 tasks, at 2 s from the app (`swift/Sources/ProfileStore.swift:17`) and 1 s from the channel
(`src/channel.ts:23`). Worse than wasted: it is not a no-op. For claude profiles `finalText` walks lines
from the end and returns the first `result` string it finds (`src/adapters.ts:214-223`), and for
codex/opencode/antigravity it returns the first `text`/`message`/`content`/`result.response` it finds
(`:252-268`) — so a worker whose answer *contains* a JSON line gets a different `output` from
`/api/state` than from `inspect` or `wait`. For `pi` profiles the function returns `raw.trim()`
(`:249`), so this route silently trims and the DB does not.

**Why it matters:** Two surfaces disagree about the same field, in the route that drives the whole GUI,
and the cost is paid on every poll forever.

**Fix:** Delete the mapping and the `finalText` import from `cli.ts`; return `listTasks(archiveFilter(...))`
as-is.

**Risk:** behavior-adjacent — it removes a divergence rather than creating one. Legacy from before
`finalText` moved into `runTask`.

**Effort:** S

### 3. Five of six body-reading routes return 500 on malformed JSON; profile creation returns 500 on every validation error — High

**Where:** `src/cli.ts:175`, `:184`, `:197`, `:228`, `:258` vs. `:279-294`; `Bun.serve` options at `:81-84`

**Problem:** `await request.json()` sits outside any `try` on `POST /api/hooks/:id` (`:175`),
`POST /api/profiles` (`:184`), `PUT /api/profiles/:id` (`:197`), `POST /api/tasks` (`:228`) and
`PATCH /api/tasks/:id` (`:258`). `Bun.serve` is configured without an `error` handler, so the thrown
`SyntaxError` becomes a bare 500. Only `POST /api/tasks/:id/resume` handles it, reading the body as
text first and returning `400 {"error":"invalid JSON body"}` (`:288-293`) — the intended shape, stated once.
`POST /api/profiles` is worse: it has no `try` at all, so every message `normalizeProfile` takes the
trouble to write — `"invalid provider"`, `"label is required"` (`src/profile-input.ts:7-11`) — is
returned as a 500 with no body. The app then throws a generic `CocoaError`
(`swift/Sources/ProfileStore.swift:45`), so the user is told nothing about what was wrong with the
profile they just typed.

**Why it matters:** The GUI's profile form cannot report why a save failed. It is the most user-visible
error path in the product.

**Fix:** One helper, used by all six routes:

```ts
async function readJson<T>(request: Request): Promise<{ ok: true; value: T } | { ok: false }> {
  try { return { ok: true, value: await request.json() as T }; } catch { return { ok: false }; }
}
```

plus wrapping the two profile routes in the same `catch` the task routes already use (see finding 6 for
the shared mapper).

**Risk:** none for the JSON handling; the profile routes change from 500 to 400 on bad input, which is
the correction.

**Effort:** S

### 4. REST bodies are cast, not validated, while zod already describes the same inputs — High

**Where:** `src/cli.ts:228-239`, `:197-214`; contrast `src/cli.ts:43-46, 325-365`

**Problem:** `POST /api/tasks` casts the body to a fully-typed shape with `as` and checks none of it:

- `prompt` has no bound here; the MCP tool caps it at 64 000 (`:332`).
- `scope` is handed to `delegate` unvalidated. The only thing standing between a malformed body and a
  crash is the hand-rolled runtime guard in `src/task-scope.ts:183` (`scope.${kind} must be an array`) —
  a check whose existence is the proof this layer does not validate.
- `allowQuestions` is consumed as `options.allowQuestions !== false` (`src/tasks.ts:259`), so the string
  `"false"` enables questions.
- A `null` body reaches `body.profile` inside the `try` and returns
  `400 {"error":"TypeError: null is not an object …"}`.

`PUT /api/profiles/:id` is the same class: `patch.env && typeof patch.env === "object"` (`:209`) accepts
an array, so `{"env":["a"]}` writes an env var literally named `0`; `patch.capabilities` is
`Array.isArray`-checked but `patch.label`, `patch.model` and `patch.provider` are each checked with a
different ad-hoc shape.

**Why it matters:** The MCP surface has a precise, self-documenting schema for exactly these inputs.
The REST surface — which the GUI uses — has prose types that TypeScript believes and nothing enforces.

**Fix:** Lift the MCP input schemas into `src/schemas.ts` (`scopeSchema` is already standalone at `:42`),
add `delegateBodySchema` and `profilePatchSchema`, and `parse` at the top of each handler; map
`ZodError` to 400 with `error.issues[0]` as the message. `normalizeProfile` then narrows to defaulting
(id derivation, model fallback) instead of validation.

**Risk:** behavior-adjacent — inputs that currently slip through start returning 400. Worth stating in
the changelog.

**Effort:** M

### 5. Provider knowledge is spread over nine files, and four of them fail silently for a new provider — High

**Where:** `src/types.ts:1`, `src/cli.ts:200`, `src/cli.ts:536`, `src/profile-input.ts:6`,
`src/task-scope.ts:433-462`, `src/profile-discovery.ts:12-53`, `src/models.ts:42-68`, `src/usage.ts:122-137`,
`src/adapters.ts:19-155`

**Problem:** 33 `provider === "…"` comparisons across six files, three `switch (profile.provider)`
blocks, and four separately maintained five-element provider lists. TypeScript catches only two of
them: `commandFor` and `usage.collect` are declared to return a value, so a non-exhaustive switch is a
`strictNullChecks` error. It does **not** catch:

- `src/cli.ts:200` — `["claude","codex","opencode","antigravity","pi"].includes(patch.provider)`, a
  string-literal array.
- `src/cli.ts:536` — `z.enum(["claude", …])` in the `profiles` tool; a sixth provider is silently
  unfilterable.
- `src/profile-input.ts:6` — `const providers: Provider[] = [...]`; omitting a member is not an error, so
  a new provider is silently rejected by profile creation.
- `src/task-scope.ts:435-460` — `profileDataPaths` is two ternary chains whose final `else` **is**
  antigravity, unnamed: `: new Set(["GEMINI_CLI_HOME"])` and `: [resolve(userHome, ".gemini")]`. A sixth
  provider silently receives Gemini's config grants and none of its own, and its worker dies at
  bootstrap on an EPERM that names nothing.

`src/profile-discovery.ts:40` also holds a second copy of the provider→binary mapping
(`item.provider === "antigravity" ? "agy" : item.provider`), the first being the literal `"agy"` in
`adapters.ts:50` and `:118`.

**Why it matters:** Adding a provider today means finding nine files by grep, four of which give no
compile error and one of which grants the wrong config directory. See the assessment section below for
the file-by-file count.

**Fix:** One table in `provider-defaults.ts`, derived everywhere:

```ts
export const PROVIDERS = {
  claude:      { binary: "claude", defaultModel: "sonnet",  configEnvKeys: ["CLAUDE_CONFIG_DIR"], configDirs: [".claude"] },
  antigravity: { binary: "agy",    defaultModel: "gemini-3.6-flash-medium", configEnvKeys: ["GEMINI_CLI_HOME"], configDirs: [".gemini"] },
  // …
} as const satisfies Record<string, ProviderSpec>;
export type Provider = keyof typeof PROVIDERS;
export const PROVIDER_IDS = Object.keys(PROVIDERS) as Provider[];
```

Then `cli.ts:200` becomes `PROVIDER_IDS.includes(...)`, `cli.ts:536` becomes
`z.enum(PROVIDER_IDS as [Provider, ...Provider[]])`, `profile-input.ts:6` and `profile-discovery.ts`'s
table both read from it, and `profileDataPaths` becomes a lookup with an explicit `antigravity` key —
no unnamed `else`.

**Risk:** none for the lists and config dirs. Argv construction stays in `adapters.ts` untouched —
`RISKY — core behavior` if anyone extends this to `commandFor`.

**Effort:** M

### 6. Seven copies of one error mapping, three different error body shapes, everything is a 400 — Medium

**Where:** `src/cli.ts:115-117, 127-129, 143-145, 252-254, 264-266, 275-277, 304-306`; `:151, :308`

**Problem:** `catch (error) { return Response.json({ error: String(error) }, { status: 400 }); }` appears
seven times verbatim. Consequences, all reachable today:

- `DELETE /api/tasks/<unknown>` → `400 {"error":"Error: unknown task: … — call tasks to list recent task ids"}`,
  while `GET /api/tasks/<unknown>/events` → `404 {"error":"unknown task"}` (`:151`). Same condition, two
  statuses, two messages.
- `String(error)` puts the JS class name into the public body (`"Error: …"`, `"TypeError: …"`).
- A genuine internal fault (SQLite failure inside `cancelTask`) is reported to the client as 400 Bad
  Request.
- The fallthrough is `new Response("Not found", { status: 404 })` (`:308`) — plain text, where every
  other error in the file is JSON.

**Fix:** One mapper next to the routes:

```ts
function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const status = /^unknown (task|profile|grant)/.test(message) ? 404
    : /must be|required|invalid|exceeds|outside/.test(message) ? 400
    : 500;
  return Response.json({ error: message }, { status });
}
```

and `Response.json({ error: "not found" }, { status: 404 })` for the fallthrough. The store's own
messages are already the right vocabulary (`src/store.ts:468, 561, 626`; `src/tasks.ts:316-323`).

**Risk:** behavior-adjacent — some responses change 400→404/500. That is the point; the GUI only
branches on `< 300` (`swift/Sources/ProfileStore.swift:52, 71`).

**Effort:** S

### 7. `TaskField` is not a union — it is `string`, so every `fields` default is unchecked — Medium

**Where:** `src/public-task.ts:15-16`; consumers at `src/cli.ts:58-69` — LIKELY FIXED: verify before working this finding

**Problem:** `export const TASK_FIELD_KEYS = [...Object.keys(TASK_FIELD_GROUPS), "all"] as const;` —
`Object.keys` returns `string[]`, so the const assertion yields `readonly [...string[], "all"]` and
`TaskField` collapses to `string`. Verified: a probe declaring
`const bogus: TaskField = "definitely-not-a-group"` and `const alsoBogus: TaskField[] = ["routng"]`
typechecks clean under `--strict`. Downstream, `DEFAULT_DELEGATE_FIELDS`, `DEFAULT_REPLY_FIELDS`,
`DEFAULT_HANDOFF_FIELDS`, `DEFAULT_CANCEL_FIELDS` and friends (`cli.ts:58-68`) accept any typo, and the
`(k): k is TaskField` predicate at `cli.ts:68` asserts nothing. Runtime validation still works —
`z.enum(TASK_FIELD_KEYS)` sees the real values — so this is latent, not broken.

*(Recheck 2026-08-04: an earlier draft of this finding also cited `fields.includes("all" as TaskField)`
as needing a cast. That cast is gone — `public-task.ts:60` now reads `fields.includes("all")`. The
`TaskField`-is-`string` defect itself is unchanged.)*

**Why it matters:** The `fields` selector is the newest and most caller-visible contract on the MCP
surface, and it is the one place with no compile-time protection. A renamed group would pass CI and
silently return the small acknowledgement instead.

**Fix:** One line, same runtime array:

```ts
export const TASK_FIELD_KEYS = [
  "routing", "context", "scope", "prompt", "shippedPrompt",
  "output", "attempts", "completion", "spend", "all",
] as const satisfies readonly (keyof typeof TASK_FIELD_GROUPS | "all")[];
```

`satisfies` keeps the list honest against `TASK_FIELD_GROUPS` — a renamed or dropped group becomes a
compile error here — and the `k is TaskField` predicate at `cli.ts:68` can go with it.

**Risk:** none.

**Effort:** S

### 8. `scopeRefusedWrite` and `scopeCoversPath` hold the same matcher twice — Medium

**Where:** `src/task-scope.ts:148-166` vs `:168-175`; also `:255-258` vs `:340-342`

**Problem:** The two predicates are character-for-character identical — same `rule === "**"` case, same
`/\/\*\*$/` strip, same `resolved === base || within(base, resolved)`. `scopeRefusedWrite` differs from
`scopeCoversPath` only in the always-writable prefix check above it (`:155-159`). Separately, the
`claude-${process.getuid()}` temp-path block is duplicated verbatim between `runtimeReadPaths`
(`:255-258`) and `runtimeWritePaths` (`:340-342`).

**Why it matters:** A fix to scope matching has to be made twice, and both are load-bearing for the
sandbox refusal path. Both are tested (`tests/task-scope.test.ts:378-410`), so the dedup is verifiable.

**Fix:**

```ts
export function scopeRefusedWrite(target, cwd, scope, scratchDir?) {
  const resolved = resolve(cwd, target);
  if (alwaysWritable(scratchDir).some((base) => resolved === base || within(base, resolved))) return undefined;
  return scopeCoversPath(scope.write, cwd, target) ? undefined : resolved;
}
```

and a `claudeTempPaths(profile)` helper for the uid block.

**Risk:** none — identical predicate, existing tests cover both call sites.

**Effort:** S

### 9. `listProfileUsage` is N+1 and sits on the delegate path, where it can stall ~30s — Medium

**Where:** `src/usage.ts:55-67`, `:143-151`; caller `src/model-router.ts:62-67`

**Problem:** After collecting usage per profile, the function runs `stateStore().listTaskSummaries({...})`
once per profile inside `rows.map` (`:60-66`) — one query per profile per call, plus `stateStore()`
re-resolved inside the loop after already being called at `:55`. And `routeModel` awaits
`listProfileUsage()` (`model-router.ts:66`), which for a claude profile spawns `claude -p "/usage"` with
a 30 s kill timer (`usage.ts:143-151`). The cache is 60 s (`usage.ts:6`), so the first `delegate` or
`route` after any idle minute waits on a subprocess before it dispatches anything.

**Why it matters:** Delegation latency depends on a quota subprocess that has nothing to do with the
task, and the query count grows with the profile list on the app's `/api/usage` route too.

**Fix (no behavior change):** one query for all profiles — `listTaskSummaries({ state: "failed", since, limit: 100 * n })`
or a `profiles: string[]` filter — then group by `profileId` in memory before `withUpstreamRateLimits`.
**Fix (behavior-adjacent, the user's call):** give the routing path a cache-only read so a cold cache
scores as "usage unknown" instead of blocking dispatch; `worstWindowUsedPercent` already returns
`undefined` for a profile with no windows, so the scorer handles absence correctly.

**Risk:** none / behavior-adjacent respectively.

**Effort:** S / M

### 10. Model discovery discards the reason it failed, then reports a healthy-looking catalog — Medium

**Where:** `src/models.ts:57-68`, `:71-86`

**Problem:** Three defects in one function. (a) `try { … } catch {}` at `:57-67` swallows every discovery
failure and returns `[model(profile, profile.model, profile.model, "configured")]` — a provider that is
not logged in is indistinguishable from one that genuinely offers one model. (b) `run()` throws
`${profile.provider} model discovery failed` (`:83`) after piping stderr and never reading it, so the
actual cause is discarded twice; the same `stderr: "pipe"` with no reader (`:74`) means a chatty CLI can
fill the pipe and hang until the 15 s kill. (c) The size guard at `:84` runs *after*
`new Response(child.stdout).text()` has already buffered the entire catalog, so it cannot prevent the
memory blow-up it is written to prevent.

**Why it matters:** "Why does this profile only show one model?" is unanswerable from the product, and
the answer is sitting unread on a pipe.

**Fix:** Read stderr alongside stdout, put its last ~200 chars into the thrown message, keep the
configured-model fallback but carry the reason out (a `ModelInfo` note or a single `console.error`), and
either drop the useless size check or enforce a byte budget while reading.

**Risk:** none.

**Effort:** S

### 11. `/api/state` truncates at 200 tasks with no indicator, and the app asks for archived rows too — Medium

**Where:** `src/tasks.ts:93-95`, `src/store.ts:638-647`, `src/cli.ts:91-107`, `swift/Sources/ProfileStore.swift:25-26`

**Problem:** `listTasks` hardcodes `stateStore().listTasks(200, archived)` with
`ORDER BY updated_at DESC, id DESC LIMIT 200`. The app polls `state?archived=include` every 2 s, so on a
DB with 306 task rows it sees the newest 200 and the rest simply are not there — no `total`, no
`hasMore`, no log line. This is the structural half of the known payload sink: the route serializes full
task rows (prompt + shippedPrompt + output + attempts) *and* silently caps them.

**Why it matters:** A silent cap reads as "you have 200 tasks". Older history vanishes from the GUI with
no explanation, and the fix for the payload size has to address the cap in the same change or it will
look like data loss.

**Fix:** Return `listTaskSummaries` (`src/types.ts:146-167` already defines exactly the right shape) plus
`{ total, hasMore }`, and add `GET /api/tasks/:id` for the detail the drawer needs. Make the limit a
parameter of `listTasks` with the default stated at the route, not buried in `tasks.ts`.

**Risk:** behavior-adjacent — the Swift `TaskSnapshot` decode changes with it.

**Effort:** M

### 12. The delegate handler calls `delegate()` twice with the same options object — Medium

**Where:** `src/cli.ts:366-388`

**Problem:** The two branches differ only in where profile and model come from and whether `selection`
rides the response; the `delegate(...)` call, the option object, the `startedTask(...)` wrapper and the
`await warningsFor(cwd, task)` spread are duplicated. The asymmetry that matters is easy to miss:
the named-profile branch passes `model` as a concrete choice and `preference` to `routeModel`, while the
automatic branch passes it as `modelHint`.

**Fix:** Resolve the destination first, then dispatch once:

```ts
const chosen = profile
  ? { profileId: profile, model: model ?? await routeModel(prompt, { preference, cwd, profileId: profile })
        .then((r) => r.model).catch(() => undefined) }
  : await routeModel(prompt, { preference, modelHint: model, cwd })
      .then((s) => ({ profileId: s.profileId, model: s.model, selection: s }));
const task = await delegate(chosen.profileId, prompt, cwd, chosen.model, parent, { scope, allowQuestions, effort, tldr, title, timeoutMs });
return result({ ...startedTask(task, resolvedFields), ...("selection" in chosen ? { selection: chosen.selection } : {}), ...(await warningsFor(cwd, task)) });
```

Keep the `.catch(() => undefined)` and its comment — that swallow is deliberate and documented.

**Risk:** none if the `modelHint`-vs-`model` distinction is preserved exactly.

**Effort:** S

### 13. A malformed `.inter.toml` is a hard error on one dispatch path and silence on the other — Medium

**Where:** `src/cli.ts:580-591` vs `src/model-router.ts:62-67`

**Problem:** `routeModel` lets `RoutingPolicyError` propagate, so automatic routing fails loudly with the
exact file and field — which is the whole point of `routing-policy.ts`'s careful error type. On the
explicit-profile path the same file is read by `policyWarnings` under
`loadRoutingPolicy(cwd).catch(() => undefined)` (`:581`), so a syntax error produces no warning, no log,
and no clue. The user gets different diagnostics for the same broken file depending on whether they
named a profile.

**Fix:** Catch it and return the message as a warning — this function's only job is emitting warnings:

```ts
const policy = await loadRoutingPolicy(cwd).catch((error) =>
  error instanceof RoutingPolicyError ? error : undefined);
if (policy instanceof RoutingPolicyError) return [policy.message];
```

**Risk:** none — adds a warning string to an existing `warnings[]`.

**Effort:** S

### 14. `warningsFor` scans a task's whole event log twice and needs a non-null assertion to do it — Medium

**Where:** `src/cli.ts:567-571` (the double call is `:569`)

**Problem:** `scopeInheritanceWarning(task)` is called in the condition and again in the body with `!`:

```ts
...(scopeInheritanceWarning(task) ? [scopeInheritanceWarning(task)!] : []),
```

Each call runs `stateStore().listTaskEvents(task.id)` (`src/tasks.ts:216`), which is up to 5 001 rows
JSON-parsed out of SQLite (`src/store.ts:697-720`) — done twice on every delegate.

**Fix:** `const inherited = scopeInheritanceWarning(task);` then
`...(inherited ? [inherited] : [])`. The `!` disappears with it.

**Risk:** none.

**Effort:** S

### 15. `chooseModel` takes seven positional parameters, four optional — Medium

**Where:** `src/model-router.ts:78-86`; smell visible at `tests/model-router.test.ts:97-104, 175-190, 204-223`

**Problem:** `chooseModel(prompt, models, profiles, options = {}, statuses = [], policy?, usage = [])`.
The tests show the cost: `chooseModel("Rename …", models, profiles, {}, [], undefined, [claudeNearLimit])`
— a positional `undefined` standing in for `policy`, and `{}`/`[]` placeholders whose meaning is only
recoverable by counting arguments against the signature.

**Fix:** One input object; `routeModel` (`:61-76`) already assembles exactly these five values, so it
becomes `chooseModel({ prompt, models, profiles, options, statuses, policy, usage })`. Update the 14 test
call sites; no assertion changes.

**Risk:** none — pure signature change, all behavior pinned by existing assertions.

**Effort:** M

### 16. `modelTraits` keeps three overlapping regex ladders that must be kept in sync by hand — Medium

**Where:** `src/model-router.ts:227-260`

**Problem:** The quality ladder (`:233-237`), the speed ladder (`:238-241`) and the no-price cost
heuristic (`:255-256`) repeat the same alternations with silent differences: `20b` appears in quality
only; `kimi-k3` and `fable` are quality-5 but absent from the cost heuristic; `flash` means "small tier"
in quality and "fast" in speed, which is exactly why `deepseek-v4-flash` needs a dedicated branch ahead
of everything (`:233`, with a good comment explaining it). Three lists, one concept.

**Why it matters:** Every new model family means editing up to three regexes correctly, and the
`deepseek-v4-flash` incident is the documented case of getting it wrong (a model no policy could ever
select).

**Fix:** One ordered table walked once:

```ts
const TIERS: Array<{ match: RegExp; quality: number; speed: number; heuristicCost?: number }> = [
  { match: /deepseek-v4-flash/,                   quality: 4, speed: 5, heuristicCost: 1 },
  { match: /(?:haiku|nano|mini|flash|spark|lite|20b)/, quality: 2, speed: 5, heuristicCost: 1 },
  // …
];
```

`tests/model-router.test.ts:449-473` pins the current numbers and must keep passing unchanged — that is
the acceptance test for this refactor.

**Risk:** none if the table preserves today's match order (first-match-wins, deepseek before flash).

**Effort:** M

### 17. `task-scope.ts` is four modules in one file, and none of its path logic can be unit-tested without the developer's real `$HOME` — Medium

**Where:** `src/task-scope.ts` — rules `:9-15, 182-226`; seatbelt emission `:37-143`; provider runtime
knowledge `:235-268, 331-345, 433-462`; toolchain knowledge `:354-411`; refusal predicate `:148-175`

**Problem:** 486 lines across four unrelated concerns, joined only by "the sandbox needs it". Every path
builder reads `homedir()` and `Bun.env` directly, so the tests have to assert against the machine they
run on: `expect(opencodePolicy).toContain(`${process.env.HOME}/.opencode`)`
(`tests/task-scope.test.ts:112`, and again at `:131-138, :150-156, :200-202`). There is no way to test
"GOPATH with a relative value falls back" or "CARGO_HOME outside home is rejected" without mutating the
process environment.

**Fix:** Split into `scope-rules.ts` (`normalizeTaskScope`, `scopeCoversPath`, `scopeRefusedWrite` — all
already pure), `sandbox-profile.ts` (seatbelt string emission), `runtime-paths.ts` (provider + toolchain
paths). Give the path builders an explicit `{ home, env }` argument, defaulted once at the
`sandboxProfile` call site. Table-driven tests become possible with no process mutation.

**Note on the known atomic-write problem:** it lands squarely here, and there is no seam for it today —
`normalizeTaskScope(scope, cwd)` takes no provider, so "grant a granted file's `.tmp.*` siblings when the
provider is claude" has nowhere to live. `expandDirectoryRule` (`:208-215`) is the decision point
(literal vs subtree, decided by `statSync`), and it is two levels below any provider knowledge. Adding
the provider to that signature is the enabling change, whichever way the policy goes.

**Risk:** none for the split. The atomic-write change itself is a scope-semantics decision, not a
refactor.

**Effort:** L — worth doing only when this file is already being opened.

### 18. `publicTask` is exported, tested, and called from nothing — Low

**Where:** `src/public-task.ts:29-32`; only callers `tests/public-task.test.ts:62, 290-291` — LIKELY FIXED: verify before working this finding

**Problem:** `cli.ts` imports `publicTaskSummary` and `taskView`, never `publicTask`. It is the
pre-`fields` artifact: the whole point of `taskView` is that callers no longer receive the full record by
default, and `publicTask` is the function that did.

**Fix:** Delete it and its two test assertions. The `sessionId` guarantee it was protecting is already
pinned by `"never emits sessionId under any fields value including all"`
(`tests/public-task.test.ts:222`).

**Risk:** none.

**Effort:** S

### 19. `canResumeSession` duplicates `resumeCommandFor`'s provider list — Low

**Where:** `src/adapters.ts:79-81` vs `:83-136` — LIKELY FIXED: verify before working this finding

**Problem:** The function enumerates all five providers, so today it is exactly `!profile.command`. The
real gate for an unlisted provider is the `throw` at `:135`. Two lists, kept in sync by hand, neither
exhaustiveness-checked (the `throw` makes `resumeCommandFor`'s switch legal when non-exhaustive).

**Fix:** Once the provider table from finding 5 exists, derive both from a `canResume` field. Not before.

**Risk:** `RISKY — core behavior` — this guards reply/resume for every provider. Leave alone.

**Effort:** S

### 20. `provider` query params are cast, not parsed — Low

**Where:** `src/cli.ts:122`, `:138`

**Problem:** `url.searchParams.get("provider") as Provider | null`. `GET /api/models?provider=bogus`
returns `200 []` (the filter in `models.ts:22-26` matches nothing and `query.profile` is unset, so the
throw at `:27` never fires), while `?profile=bogus` returns 400. The same class of client mistake gets
two different answers, one of them indistinguishable from "this provider has no models".

**Fix:** Parse against `PROVIDER_IDS` (finding 5); unknown → 400 with the valid list.

**Risk:** behavior-adjacent.

**Effort:** S

### 21. `POST /api/hooks/:id` accepts an unbounded body into the event log — Low

**Where:** `src/cli.ts:171-181`; contrast `src/tasks.ts:24-25, 459-472`

**Problem:** The route validates only that the payload is a non-array object, then writes it straight
into `task_events`. The stdout path feeding the same table caps a line at `MAX_EVENT_LINE` (64 KB), caps
the run at `MAX_EVENTS` (5 000) and emits an `event_dropped` marker when it trims. The HTTP path has
neither cap and no event ceiling, so any local process can grow the DB without limit — including against
an already-completed task.

**Why it matters:** The localhost bind is the only mitigation, and the asymmetry with the stream path
looks accidental rather than decided.

**Fix:** Reject bodies whose `content-length` or serialized size exceeds `MAX_EVENT_LINE`, reusing the
constant; return 413.

**Risk:** behavior-adjacent — a hook payload over 64 KB starts being rejected.

**Effort:** S

## Provider abstraction assessment

The adapter layer is not an interface — it is a set of parallel switch statements that happen to be
keyed the same way. There is no `ProviderAdapter` type anywhere in `src/`.

**Adding a sixth provider today touches nine files:**

| File | What changes | Does TypeScript catch omission? |
| --- | --- | --- |
| `src/types.ts:1` | `Provider` union | — (this is the source) |
| `src/adapters.ts:19, 83, 138, 213` | `commandFor`, `resumeCommandFor`, `sessionIdFrom`, `finalText` | **Yes** for `commandFor` (must return `string[]`); no for the others |
| `src/adapters.ts:79-81` | `canResumeSession` list | No — returns `false`, resume silently unavailable |
| `src/models.ts:42, 50-56, 59-65` | discovery command *and* parser, two aligned chains | No — falls through to the opencode parser |
| `src/usage.ts:122` | `collect` | **Yes** — must return `ProfileUsage` |
| `src/task-scope.ts:65-74, 255-258, 340-342, 433-462` | provider bootstrap rules, temp paths, `profileDataPaths` | No — and `profileDataPaths` silently grants Gemini's dirs |
| `src/profile-discovery.ts:12-31, 40, 49` | discovery table + the `agy` binary special case | No |
| `src/cli.ts:200, 536` | two hand-written provider lists | No — silently rejected by PUT and by the `profiles` tool |
| `src/profile-input.ts:6` | a third hand-written list | No — `Provider[]` does not require completeness |
| `src/provider-defaults.ts:13` | default model | **Yes** — `Record<Provider, string>` |

So four of the nine sites fail silently, and one of them (`profileDataPaths`) fails *wrongly* rather than
merely incompletely: the unnamed `else` branch is antigravity, so a new provider inherits
`GEMINI_CLI_HOME` and `~/.gemini` and gets none of its own config granted.

**What should change:** three files. `provider-defaults.ts` gains the `PROVIDERS` table (id, binary,
default model, config env keys, config dirs, `canResume`) and exports `Provider` and `PROVIDER_IDS` from
it; `adapters.ts` gains one argv case; `models.ts` gains one parser. Everything else —
`cli.ts` ×2, `profile-input.ts`, `profile-discovery.ts`'s table and its `agy` special case,
`task-scope.ts`'s `profileDataPaths` — should be derived, not edited. That is the whole of finding 5, and
it is achievable without touching a single argv array.

The `sessionIdFrom`/`finalText` pair is a different story: those are per-provider stream-shape parsers
with hard-won comments (`adapters.ts:147-151, 226-229, 242-247`) and they are the load-bearing core.
They would read better as a `Record<Provider, {sessionId, finalText}>` lookup, but the payoff is
readability only. `RISKY — core behavior`; leave them.

## Nits

- `src/cli.ts:252` and `:264` — `patchTaskId` and `cancelTaskId` compute the identical regex
  `/^\/api\/tasks\/([^/]+)$/` twice. Match once.
- `src/cli.ts:66-69` — `DEFAULT_INSPECT_FIELDS` is defined by *excluding* names from a `Set<string>`;
  rename a group and the exclusion silently stops matching, widening the default. List the seven wanted
  groups explicitly.
- `src/cli.ts:532-533` — the `profiles` tool says "Bypass the five-minute cache"; the real TTLs are 30
  minutes (`models.ts:4`) and 60 seconds (`usage.ts:6`). Wrong number in protected tool copy — flag it
  before editing.
- `src/cli.ts:36` — `Number(Bun.env.INTER_PORT ?? 7331)`; `INTER_PORT=abc` makes `Bun.serve` throw at
  import with no diagnostic.
- `src/cli.ts:608-616` — `publicProfile` is typed `(profile: Profile) => Profile` but returns masked env, so
  the type says the secrets are real. Note in a doc comment at minimum; `PUT` at `:208` depends on the
  `"••••••••"` sentinel round-tripping, which is worth stating where the mask is produced.
- `src/cli.ts:593` and `src/channel.ts:256` — the same four-line `result()` helper in two files. Share it.
- `src/channel.ts:35-46` — `TaskView` re-declares nine `Task` fields with `state: string`, so a
  `TaskState` change never reaches it, and `eventContent`'s `default:` branch (`:143`) exists only to
  satisfy that looseness. `Pick<Task, "id"|"profileId"|"cwd"|"state"|"title"|"question"|"error"|"output"|"completion">`
  fixes it; `tests/channel.test.ts:5` then needs `state: TaskState`.
- `src/channel.ts:31` — `WORTHY_STATES` is `Set<string>`; with the `Pick` above it can be
  `ReadonlySet<TaskState>`.
- `src/profile-discovery.ts:88` — `provider: Provider = id as Provider` defaults the provider by casting
  the id. It works only because three of five ids equal their provider name. Make the parameter required.
- `src/models.ts:50-65` — two parallel provider ternary chains (command, then parser) that must stay
  aligned by hand; one lookup keyed by provider would make misalignment impossible.
- `src/profile-status.ts:28-42` — the injected-dependency object is the only DI seam in `src/`, exercised
  by exactly one test (`tests/profile-status.test.ts:109-129`). Keep it, and copy the pattern into
  `models.ts`/`usage.ts` rather than removing it.
- `src/prompt-paths.ts:10-34` — `promptReadPaths` caps *found* paths at 50 but not tokens examined, so a
  64 KB prompt can `statSync` every token containing `/` or `.`. Cap the token count too.
- `src/routing-policy.ts:92-158` — hand-rolled validation where zod is already a dependency. Left as-is
  deliberately: the custom `RoutingPolicyError` messages (`invalid routing policy <path> at
  routes.build.allow[0].provider: …`) are better than what a zod mapping would produce, and
  `tests/routing-policy.test.ts:50` pins them. Noted so nobody "modernizes" it.
- `src/memories.ts:50-58` and `src/tasks.ts:332-342` — two copies of the INTER_ROOTS containment check
  with different error text. Share one `assertInsideRoots(cwd)`.

## What is already good

- **`src/public-task.ts`** — the `fields` design. Groups declared once in one table, one function that
  reads it, `sessionId` structurally impossible to emit, and 20 tests pinning exactly that. Finding 7 is
  a one-line type fix, not a criticism of the design.
- **`src/routing-policy.ts`** — the best-validated input in the repo. `rejectUnknownFields` on every
  level, a typed error carrying file *and* field path, anchored glob matching that escapes the pattern
  before turning `*` into `.*` (`:160-166`), IDs normalized once at the boundary. Don't touch it.
- **`ChannelWatcher`** (`src/channel.ts:66-101`) — a pure class with its invariant written down
  ("announce each worthy state exactly once"), a bounded map whose eviction trade-off is stated in a
  comment rather than hidden, and tests that pin the first-poll seeding rule including the `needs_input`
  exception.
- **`src/worker-path.ts`** — one narrow concern, a documented reason for every decision, throttled on
  success *and* failure, sentinel-fenced shell capture because rc files print banners, and a
  `resetWorkerPath()` export that exists purely so tests can control it. This is the model the rest of
  the runtime-path code should follow.
- **`src/mcp-wait.ts`** — five lines, one clamp, three tests. Exactly the right size for what it does.
- **`src/adapters.ts` argv construction** — every non-obvious flag carries the provider bug it works
  around (`:29-30, 45-48, 55-60, 66-68, 123-126`). This is load-bearing knowledge that would be
  expensive to rediscover. Leave it alone.
- **Comment culture generally** — comments explain *why*, not what: `models.ts:7-12`,
  `task-scope.ts:54-58, 78-82`, `usage.ts:70-71`, `model-router.ts:149-150, 162-163`,
  `bunfig.toml:2-6`. Rare and worth preserving under any refactor.
- **`src/task-protocol.ts`'s marker regexes** — line-anchored but not end-anchored, with the reason
  ("workers often append a summary after the marker") stated at `:4-6`. Subtle and correct.

## Suggested order of work

1. **Findings 2 and 14** — delete the redundant `finalText` mapping and the double event-log scan.
   Minutes of work, both on hot paths, both strictly removals.
2. **Findings 3 and 6** — one `readJson` helper and one `errorResponse` mapper. Removes seven duplicated
   catch blocks and three error body shapes, and fixes the profile-save 500 the GUI cannot explain.
3. **Finding 7** — the one-line `TaskField` fix, so every `fields` default becomes checked code before
   anything else is built on it.
4. **Finding 1** — the `cli.ts` split. Do it before step 5 so the new request validation has a testable
   place to live, and so steps 2–3 get regression tests retroactively.
5. **Findings 4, 20, 21** — request schemas on the REST surface, reusing the MCP schemas as the spec.
6. **Finding 5** — the `PROVIDERS` table. Highest leverage per line changed, and it closes the four
   silent-failure sites including the wrong-config-dir one.
7. **Findings 9 and 10** — the usage N+1 and the discovery diagnostics. Independent of everything above.
8. **Finding 11** — the `/api/state` payload and cap work, coordinated with the Swift decode.
9. **Findings 15, 16, 17** — `model-router` signature, the traits table, and the `task-scope` split, when
   those files are next opened for other reasons. Real wins, no urgency.
