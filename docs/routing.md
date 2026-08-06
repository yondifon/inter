# Choosing a profile, model, and effort

Every dispatch lands on one account and one model, at one reasoning level. The
caller can name all three, none of them, or the account only — and Inter fills
in the rest from four inputs: what the caller declared about the work, what the
project's `.inter.toml` allows, what each connected account actually offers, and
how much of its usage window is left.

## Three paths through `delegate`

| What the caller names | What Inter does |
| --- | --- |
| Nothing | Routes: filters every model on every enabled account, scores the survivors, picks one. |
| A profile | Routes within that account only, so the project policy's own order decides which of its models runs. |
| A profile and a model | Runs exactly that. The same filters still execute — as advice, attached to `warnings`, never as a refusal. |

The third row is the important one. Naming an account is the caller's call, but
sending work to an account with revoked credentials should not be silent. Every
filter that would have excluded the pair becomes a warning on the response
instead, and the dispatch proceeds.

## Difficulty is the one thing the caller declares

`difficulty` is optional on `delegate` and `route`, and defaults to `standard`.
It is the only judgment the caller is asked for, because the caller wrote the
prompt.

| `difficulty` | Capability floor | Effort target on the model's ladder |
| --- | --- | --- |
| `mechanical` | 2 of 5 | 10% |
| `standard` | 3 of 5 | 30% |
| `hard` | 4 of 5 | 60% |
| `critical` | 5 of 5 | 90% |

The default sits low deliberately: declaring too high buys one over-priced
success, declaring too low buys a cheap retry.

A prompt heuristic classifies the work independently — `mechanical`, `context`,
`build`, `reasoning`, or `general` — and that class picks the `.inter.toml`
route. It never overrides the declaration. When it wants a stronger tier than
the declared difficulty allows, `heuristicAgreed` goes false and, if the caller
declared a difficulty explicitly, a warning says so:

```
this reads like deep judgment or failure analysis but was sent as standard work;
raise difficulty if the result comes back thin
```

Nothing is silently upgraded. A default difficulty produces no such warning —
warning about the word "implement" on every prompt would be noise.

## Effort is read off the model, never invented

Providers publish different reasoning ladders: five rungs on Claude, six on pi,
none on some models. The difficulty's target is projected onto whatever the
chosen model actually publishes, so the level Inter asks for is always one that
model accepts.

Ladders whose rungs all fall inside Inter's own vocabulary — `minimal`, `low`,
`medium`, `high`, `xhigh`, `max` — are sorted into that order before the
projection, so a provider that publishes its levels in some other order projects
correctly anyway. A ladder using words outside the vocabulary keeps its
published order. **A model that publishes no ladder gets no effort flag** rather
than an invented one.

Passing `effort` explicitly overrides the projection. If the model's published
levels do not include it, the value is passed through as asked, with a warning
naming what the model does accept.

## Project policy: `.inter.toml`

A `.inter.toml` in the task's `cwd` constrains which provider/model pairs may
run there. It is read from the task's directory, never from wherever the broker
was launched, and it names providers and model patterns — never local profile
IDs, so a committed file stays portable across clones.

```toml
version = 1

[routes.build]
preference = "quality"
min_quality = 5
allow = [
  { provider = "claude", model = "opus" },
  { provider = "opencode", model = "opencode-go/*" },
]

[routes.reasoning]
preference = "quality"
allow = [
  { provider = "claude", model = "*" },
  { provider = "codex", model = "*" },
]
```

Route keys are the five task classes: `mechanical`, `context`, `build`,
`reasoning`, `general`. Each takes a non-empty `allow` list plus optional
`preference` (`balanced`, `quality`, `cost`, `speed`) and `min_quality` (an
integer 1–5, applied as a floor alongside the difficulty's).

`allow` entries are matched against normalized lowercase IDs. `provider` is
exact; `model` accepts `*` as a wildcard and nothing else — no regex. **Order
matters**: entries are written best-first, and when the caller has already named
the account, that order is what picks the model.

Omitting a class from `[routes]` leaves it unconstrained. Omitting the file
entirely leaves routing exactly as it is without one. A file containing only
`[worker]` is complete and valid — it carries prompt rules, not routing, and
needs no `version`.

Anything else fails loudly, naming the file and the exact field:

```
invalid routing policy /path/.inter.toml at routes.build.min_quality: must be an
integer from 1 to 5
```

An `allow` entry that matches no model any connected account offers is reported
per entry, and selection continues with the remaining entries:

```
project policy allows claude model opus for build work, but no connected account
offers it; remove the entry or connect that account
```

Policy is the authority on the automatic path — it cannot select outside
`allow`. An explicit profile-and-model pair outside it still runs, and carries a
warning saying it overrode the project's policy.

## Account availability

Availability is recorded from what actually happened, not probed. Every profile
carries one of three states, and `profiles(include: ["status"])` returns them
with the evidence behind each:

| State | Set by | Effect on routing |
| --- | --- | --- |
| `unavailable` | An observed `auth` or `billing` failure, or a `network`/`rate_limit` failure whose `retryAt` has not passed | Excluded on the automatic path, with the reason and retry time in a warning |
| `available` | An observed successful generation | Scored normally |
| `unknown` | No observed outcome yet, or a retry time that has passed without a recheck | Stays eligible, with a warning |

Auth and billing failures have no retry time: they stay unavailable until a
successful run clears them. Catalog access is not evidence — an account can list
its models and still be out of credits, so a refresh that only reads a catalog
reports `unknown` rather than `available`. No availability check ever sends a
prompt or spends inference credit.

## Quota

`profiles(include: ["usage"])` reports session and weekly windows where the
provider exposes them. Selection reads the worst window on each account:

- **At 98% or more**, the account is filtered out on the automatic path — a run
  that dies part-way through is worse than a slower model. A caller that named
  the account keeps the dispatch and gets the warning.
- **At 90% or more**, a caller-named account is warned that the run may stop
  part-way through.
- **From 75%**, the account is deprioritized by a scoring penalty rather than
  excluded, so a cheap model on a busy account can still win.

A provider that reports no usage at all — opencode and pi report none — is
**unknown headroom**: never filtered, never credited. `quotaUsedPercent` is
`null` for those. Reading silence as spent would exclude the accounts carrying
most of the work; reading it as free would make silence the cheapest thing to
buy.

## The order things are filtered

1. **Capability** — accounts that are disabled, models that cannot call tools,
   and image/video/audio/embedding/TTS models.
2. **Model hint** — exact ID, then bare name, then substring. A hint matching
   nothing is an error, not a fallback.
3. **Policy** — the `allow` list for this task class.
4. **Availability** — recorded `unavailable` accounts.
5. **Quota** — the 98% cutoff, automatic path only.
6. **Floor** — models below the capability tier the difficulty demands.

The floor is the one filter that gives way. When nothing clears it, it drops a
tier at a time until something does, and the route reports `floorRelaxed: true`
with a warning — a run below the intended tier beats no run, and the record says
which happened.

Survivors are scored on quality, cost, and speed, weighted by `preference`, less
the usage penalty. Ties break on the policy's `allow` order (only when the
caller named the profile), then score, then profile ID, then model ID.

## When nothing survives

Selection fails with a structured error rather than a guess:

```
code: "no_eligible_model"
rejected: [{ profileId, model, stage, reason, retryAt? }]
earliestRetryAt: "2026-08-06T09:40:00.000Z"
```

`stage` is one of `floor`, `quota`, `availability`, `catalog`, `policy`,
`capability`, `profile`. Rejections are ordered most-informative first and
capped at 12 — a full list of every model a policy was never going to allow is
noise. `earliestRetryAt` is there so a caller who learns an account frees up in
forty minutes can wait instead of guessing at another one.

## Previewing and reading back

`route(prompt, cwd, difficulty?, modelHint?, preference?)` runs the whole
selection without starting anything, and returns what it would pick, the
reasoning level it would ask for, up to three runners-up from distinct accounts,
and why each account it passed over was ruled out.

`delegate` returns the same decision as `selection` on its response, and stores
it on the task row. It records `decidedBy` — `router`, `caller-profile`, or
`caller-explicit` — so a good routing call and a lucky caller guess stay
tellable apart when the outcome is read later.
