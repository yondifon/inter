# Feature requests from a calling agent

Written from the point of view of the agent driving Inter, not the person who
built it. I ran a full session on 2026-07-30: four landing-page variants
delegated across all four enabled profiles, plus a cross-review and a
`needs_input` round trip. Defect detail and reproductions are in
[dogfood-2026-07-30.md](dogfood-2026-07-30.md); this file is what I wanted and
did not get.

Ordered by how much each one cost me during the run.

---

## FR-1 — Tell me something when `wait` wakes me

**Severity: high. This is the one that made me stop trusting the tool.**

What I was doing: three builds running in parallel. I called `wait` and asked for
up to 150 seconds.

What happened: it came back in about two seconds with `reason: "progress"`, three
tasks all showing `output: ""`, and `updatedAt` still equal to `createdAt`. So I
called it again. Same thing. Nothing in the response told me whether a worker had
read a file, written a file, hit an error, or was simply thinking.

I gave up on `wait` and ran `sqlite3 ~/.inter/inter.db` to read `task_events`
directly. That is where I found out what was actually going on — heartbeats
carrying `{"elapsedMs":140019,"silentMs":109241,"stalled":true}`, tool calls,
assistant turns. All of it was already there. None of it was reachable through
the MCP surface I am supposed to use.

When an agent has to bypass your product and read your database to do the job
your product exists for, the API is the bug.

**What I want:** `wait` returns the events that occurred since `afterCursor`.
Even a trimmed shape would have been enough:

```
{ reason, cursor, tasks: [...],
  events: [ {taskId, type, at, summary} ],
  progress: { taskId: {elapsedMs, silentMs, stalled} } }
```

**Done when:** I can follow a delegated task from start to finish without opening
the database.

---

## FR-2 — Never tell me a task succeeded when it did nothing

**Severity: high. This one can silently corrupt my work.**

What I was doing: asked a worker to write one line into
`examples/landing-meta.txt`.

What happened: the task came back `state: "completed"`. Output was
`"Awaiting permission to write the file."` The file did not exist. I only caught
it because I habitually `ls` the artifacts.

If I had trusted `state` — which is exactly what the README tells me to do — I
would have gone on to reference a file that was never created, and the failure
would have surfaced three steps later with no obvious cause.

Right now `completed` means "the process exited 0". That is not the same as "the
work happened", and I have no way to tell the two apart.

**What I want:** either a state that distinguishes them (`completed` vs
`blocked` / `abandoned`), or a `completion` block I can check:

```
"completion": { "exitCode": 0, "blocked": true, "reason": "permission_denied" }
```

Detecting "awaiting permission" / "I need approval" / "I cannot proceed" in the
final output and refusing to call that `completed` would have caught my case.

**Done when:** a worker that writes nothing and asks for permission does not
report the same state as a worker that finished the job.

---

## FR-3 — Let me declare the workspace scope, and enforce it

**Severity: high. It is the one place the design asks me to promise something I cannot keep.**

Before my first `delegate` I am required to ask the user: "Allow Inter to share
`<scope>` with `<provider>` profile `<label>`?" I did. The user answered with a
real constraint — *this repo only, write only under `examples/` and `docs/`*.

Then I discovered I had no way to hand that constraint to Inter. `delegate` takes
`prompt`, `cwd`, `profile`, `model`, `preference`. That is all. So I did the only
thing available: I wrote the boundary into English in every prompt — "Do not
modify any file outside `examples/landing-codex/`" — and hoped four different
models on three different vendors would each respect it.

They did, this time. I verified with `git status` afterwards. That is luck, not a
guarantee, and I had to spend a verification step confirming something the tool
should have made impossible.

`INTER_ROOTS` exists but it is a global setting on the broker, currently the
whole home directory. It is not per-task, and I cannot set it as a caller.

**What I want:** `delegate` accepts a scope and the broker enforces it.

```
"scope": { "read": ["README.md", "docs/**"], "write": ["examples/landing-codex/**"] }
```

A write outside `write` fails the task with a clear reason instead of succeeding
quietly.

**Done when:** the consent I obtain from the user is a thing the system enforces,
not a sentence I put in a prompt.

---

## FR-4 — Make `needs_input` something the worker actually knows about

**Severity: high. The feature is documented, shipped, and unreachable by default.**

What I was doing: testing the `reply` flow. I handed a worker a genuine product
decision it should not make alone.

What happened the first time: it picked one and moved on, because nothing in the
world had told it that asking was an option.

I went and read `src/tasks.ts` and found the sentinel is matched against worker
output by regex. But `commandFor` in `src/adapters.ts` passes my prompt straight
through with no system prompt. So the only way a worker ever emits
`INTER_NEEDS_INPUT:` is if I, the caller, type the magic string into every single
prompt myself.

I did that, and then it worked perfectly — clean `needs_input`, populated
`question`, `reply` created a linked continuation, the child consumed my answer
and wrote the correct file. The machinery is good. It is just switched off unless
you already know the secret.

**What I want:** the adapter appends the protocol to every delegated prompt, so
every worker on every provider knows it can pause and ask. Optionally
`delegate({ allowQuestions: false })` to suppress it.

**Done when:** a caller who has read only the README gets a `needs_input` when
the worker hits a real ambiguity.

---

## FR-5 — Give me a way to stop a task

**Severity: high. There is currently no way out.**

There is no cancel tool. `delegate`, `route`, `models`, `wait`, `health`,
`inspect`, `tasks`, `reply`, `profiles` — that is the whole surface.

One of my tasks sat at `silentMs: 109241` with `stalled: true`. I had no idea
whether it was thinking or dead, and no way to end it and retry. My only options
were to keep waiting or abandon the task ID and let it run — burning an external
account's tokens on work I no longer wanted.

I also could not stop a task after I had learned it was pointless. When the
opencode run died on billing, its sibling work was already moot, and I had to let
it finish.

**What I want:** `cancel(taskId, reason?)` that kills the worker process and
moves the task to `cancelled`. Ideally also a `timeoutMs` on `delegate` so a task
that exceeds it self-cancels.

**Done when:** I can start work I might not want, because I can stop it.

---

## FR-6 — Make `tasks` usable

**Severity: medium. It broke the first time I called it for real.**

```
Error: result (63,373 characters across 441 lines) exceeds maximum allowed tokens.
```

`tasks` takes no arguments and returns every task ever run, each with its full
prompt and its full output. My prompts were long. After one day of use, the tool
that exists to let me see my own work will not fit in a response.

I never got to use it. I queried SQLite instead.

**What I want:** `tasks({ limit, state, since, profile })`, and the list view
returns a truncated prompt and no output at all. `inspect` is already there for
detail.

**Done when:** `tasks` still works after a hundred tasks.

---

## FR-7 — Route on what a model can actually do right now

**Severity: medium. Routing sent me to a model that could not run.**

I asked `route` for a build task at `preference: "quality"`. It gave me opencode
models. I picked one with a good code reputation and delegated. It died in eight
seconds:

```
Insufficient balance. statusCode: 401, type: CreditsError
```

The router had scored it on its *catalog* price. Nobody checked whether the
account could pay.

The related problem: every route I tried — quality, cost, balanced, three
different task shapes — returned opencode, nine candidate slots out of nine.
Claude and Codex never appeared once. Their catalog entries carry no `cost` field
at all, while opencode's free tier reports `cost: 0`, so the price term decides
everything and the two providers that actually had working credit were invisible.

The result is that automatic routing points at the one provider that could not
run paid work, and I only found out by burning a task.

Also, at `preference: "balanced"` a quality-4 model scored 60 and a quality-5
model scored 58 — asking for balance actively demoted the better model.

**What I want:** track recent auth/billing failures per profile and drop those
models from candidates until they succeed again. Treat missing `cost` as unknown
rather than infinitely expensive. Surface a `warnings` array on `route` when a
whole provider is being excluded and why.

**Done when:** `route` does not recommend a model that failed on billing sixty
seconds ago, and a provider with no price data can still win on quality.

---

## FR-8 — Close out a question once I have answered it

**Severity: medium. It quietly poisons later waits.**

`reply` worked well. But the parent task stays `needs_input` forever:

```
4c2b2de9 | parent 673ffd1b | completed
673ffd1b | -               | needs_input
```

`wait` treats `needs_input` as needing attention. So any answered parent left in
a watch list makes `wait` return `attention` instantly and permanently. Every
question I ever answer becomes a permanent tripwire, and the menu bar will show
pending work that is not pending.

**What I want:** creating a continuation moves the parent to `answered` (or
`superseded`), with `childTaskId` on it so I can follow the chain forwards, not
just backwards.

**Done when:** answered questions stop counting as open ones.

---

## FR-9 — Reconcile the continuation prompt instead of concatenating it

**Severity: low. It worked, but only because the model was good.**

The continuation prompt was my original prompt, plus the question, plus my
answer, glued end to end. So the worker received this:

```
Make your FINAL output exactly one line ... and stop without writing the file:
INTER_NEEDS_INPUT: <your question>
...
Do not modify any file.
```

immediately above my answer telling it to write the file. Two directly
contradictory instruction sets in one prompt. Sonnet figured out which one was
current. A weaker model would have re-asked the same question forever, or
refused.

**What I want:** structure the continuation instead of gluing it — original task
as context, then the resolved decision, then an explicit "this supersedes any
earlier instruction that conflicts with it".

**Done when:** the continuation does not depend on the worker guessing which half
of its prompt is stale.

---

## FR-10 — `--permission-mode auto` is not a real mode

**Severity: high as a bug, trivial as a fix. Root cause of FR-2.**

`src/adapters.ts` builds every Claude command with `--permission-mode auto`.
`auto` is not a valid value. The CLI accepts it silently and falls back to
prompting, so delegated workers can be refused permission to write.

Reproduced with the same account, model, and prompt, changing only the flag:

```
--permission-mode auto        -> "I need your permission to write to ./a.txt"   file: NO
--permission-mode acceptEdits -> "DONE"                                          file: YES
```

It is intermittent in practice — my `opus` and `sonnet` runs wrote files fine,
`haiku` did not — which is worse than a hard failure, because it looks like model
flakiness rather than a bad flag.

**What I want:** `acceptEdits`, and validation of the value against the CLI's
accepted set at startup so an unknown mode fails loudly instead of degrading.

**Done when:** a delegated Claude worker can write to its own workspace every
time.

---

## FR-11 — Small things

- **`inter --help` does not exist.** `package.json` registers `bin.inter`, but
  the file goes straight to `Bun.serve()`. With the broker already up I got a raw
  `EADDRINUSE` stack trace instead of "broker already running on :7331".
- **The README tells me to keep a cursor that `delegate` does not return.** Step 4
  says "keep the returned task ID and event cursor". `delegate` returns no
  cursor. Only `wait` produces one, so on my first `wait` I had nothing to pass
  as `afterCursor`.
- **`delegate` returns a `selection` block when it auto-routes** — `taskClass`,
  `requiredQuality`, `reason`, scored candidates. It is genuinely useful and it
  is not in the README's tool list. Document it.

---

## What already works well, so it does not get broken

- `route` touches no files, so I can safely call it before asking the user for
  consent. That ordering is exactly right and the agent instructions depend on it.
- Parallel delegation across three vendors at once was stable. Nothing raced,
  nothing interleaved, no cross-contamination between the three workspaces.
- Every worker respected the plain-English directory boundary I gave it. `git
  status` afterwards showed no file touched outside the assigned directories.
- `reply` correctly links parent to child via `parentTaskId`, and the child
  really does act on the answer — the file it wrote reflected the specific option
  I chose, not the alternative.
- Per-profile `CLAUDE_CONFIG_DIR` worked. Two separate Claude accounts ran
  concurrently without interfering.
- `models` filtering by profile and provider, and `refresh`, behaved as
  documented.
