# Worker rules (`[worker]`)

Every task Inter dispatches ships with a preamble wrapped around the caller's
prompt: the scope line, the rules the worker should follow, and the status lines
it must sign off with. Most of that preamble is machinery — Inter reads those
lines back out of the worker's final message. The rules are not. They were one
person's preferences hardcoded into the source, and a project can now set its
own in `.inter.toml`.

## What Inter ships on its own

Some rules cost a run every time a brief forgets them, so Inter sends them with
every dispatch. A caller writes nothing to get them.

Under `## How to work`:

1. Blocked means stop. A command that will not run, a missing credential, an account or signup, a permission denial, a path outside your scope, a decision this brief does not answer — stop and report it, naming the blocker and the one decision you need.
2. Do not work around a blocker. No retry loops, no second tool for the same job, no creating accounts, no linking or authenticating anything, no editing outside your write scope, no faking or stubbing the result.
3. One attempt, then report. If the same command fails twice the same way, that is the answer — quote the error exactly and stop.
4. Partial work is a valid result. Finish what is unblocked, then report what you stopped on. Never discard finished work to keep trying.
5. Never report a result you did not observe. If you could not run a check, say so and say why, instead of describing an outcome you did not see.
6. Build on what is already there. When the brief says something is done, read it and continue from it instead of starting over.

Under `## User rules`, after the TL;DR rule and only when that rule is on, since
both describe the same block:

1. Write that TL;DR as bullets — one idea per line, never a paragraph — and make it stand alone: no bullet may need the detail below it to make sense.
2. Cover in it, one line each: the verdict, done or partial or blocked; what changed or was found, with every changed path on its own line; each check you ran and its result, quoting any failure exactly; and what is left, broken or uncertain, or "nothing".

A project's own `conduct` and `report` rules are printed after these, numbered
on from where they end — writing your own guardrails adds to Inter's rather than
replacing them. `builtins = false` turns both lists off for a project that
genuinely does not want them, and leaves everything else it configured intact.

## What a project can set

```toml
version = 1

[worker]
tldr = true
tldr_sentences = "2-4"
tldr_template = "Open your final report with `## TL;DR` — {count} stating what was done or found and the outcome. Detail follows after; this applies to your final answer, not to intermediate messages."
builtins = true
conduct = [
  "Run `bun test` before you report, and paste the tally.",
  "Never write files with shell redirects; use your editing tools.",
]
report = [
  "Cite every claim about the code as path:line.",
  "List the files you changed, one per line, before any prose.",
]
```

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `tldr` | boolean | `true` | Whether the worker is told to open its report with a `## TL;DR`. |
| `tldr_sentences` | string | `"1-3"` | How long that TL;DR should be — a count (`"2"`) or a range (`"1-3"`). |
| `tldr_template` | string | see below | The literal wording of the TL;DR rule. `{count}` is replaced with what `tldr_sentences` resolves to. |
| `builtins` | boolean | `true` | Whether the rules Inter ships on its own are sent. `false` leaves only what you write. |
| `conduct` | array of strings | none | How the worker should work. Shown as its own numbered section, before the report rules. |
| `report` | array of strings | none | How the worker should report back. Numbered after the TL;DR rule. |

`tldr_template` defaults to:

```
Open your final report with `## TL;DR` — {count} stating what was done or found and the outcome. Detail follows after; this applies to your final answer, not to intermediate messages.
```

Edit it to change the rule's wording; `tldr_sentences` still controls the length that fills `{count}` (and still gets validated as a count or range), so the two work together rather than one replacing the other. `tldr_template` itself follows the same caps as a single rule — one line, 500 characters — and must keep the `{count}` placeholder, since dropping it would silently discard the length instruction.

`[worker]` is the only new table. A `.inter.toml` that had no routing policy
before does not need one now: `[worker]` on its own is a complete file, and
`version = 1` is only required once `[routes]` is present.

Each rule is one line and stands on its own. At most 20 rules per key, 500
characters per rule, 4,000 characters per key.

## What the worker actually reads

With the config above, and read scope over the whole tree, the preamble becomes:

```
<inter_protocol>
This reporting protocol is part of the task contract.
File access is OS-enforced relative to your working directory — readable: the whole working directory; writable: src/**. Access outside that scope fails with "operation not permitted"; report it as out of scope instead of retrying.

## How to work
The rules below are set by your user and apply to how you carry out this task.
1. Blocked means stop. A command that will not run, a missing credential, an account or signup, a permission denial, a path outside your scope, a decision this brief does not answer — stop and report it, naming the blocker and the one decision you need.
2. Do not work around a blocker. No retry loops, no second tool for the same job, no creating accounts, no linking or authenticating anything, no editing outside your write scope, no faking or stubbing the result.
3. One attempt, then report. If the same command fails twice the same way, that is the answer — quote the error exactly and stop.
4. Partial work is a valid result. Finish what is unblocked, then report what you stopped on. Never discard finished work to keep trying.
5. Never report a result you did not observe. If you could not run a check, say so and say why, instead of describing an outcome you did not see.
6. Build on what is already there. When the brief says something is done, read it and continue from it instead of starting over.
7. Run `bun test` before you report, and paste the tally.
8. Never write files with shell redirects; use your editing tools.

## User rules
The rules below are set by your user and apply to every delegation. Honor them for your final report.
1. Open your final report with `## TL;DR` — 2-4 plain-language sentences stating what was done or found and the outcome. Detail follows after; this applies to your final answer, not to intermediate messages.
2. Write that TL;DR as bullets — one idea per line, never a paragraph — and make it stand alone: no bullet may need the detail below it to make sense.
3. Cover in it, one line each: the verdict, done or partial or blocked; what changed or was found, with every changed path on its own line; each check you ran and its result, quoting any failure exactly; and what is left, broken or uncertain, or "nothing".
4. Cite every claim about the code as path:line.
5. List the files you changed, one per line, before any prose.
If a product choice, secret, destructive action, or new authority is required, stop and end with: INTER_NEEDS_INPUT: <one clear question>
If the requested work is fully done, end with: INTER_RESULT: completed
If work cannot be completed, end with: INTER_BLOCKED: <permission_denied|needs_authority|worker_error> | <short reason>
Emit exactly one of those status lines as the final non-empty line of your final message. Do not claim completion before the work is done.
</inter_protocol>
```

Set nothing and you get the same thing without lines 7, 8, 4 and 5, and with
the TL;DR rule at `1-3` sentences. A section with no rules in it prints no
heading, so `builtins = false` with nothing of your own removes `## How to
work` entirely.

To see the real thing for a task that already ran, read its shipped prompt:
`inspect` with `fields: ["shippedPrompt"]`.

## What a project cannot set

The rest of the preamble is how Inter and the worker understand each other, and
none of it is configurable:

- **The two status lines and the question marker.** Inter reads `INTER_RESULT`,
  `INTER_BLOCKED` and `INTER_NEEDS_INPUT` back out of the worker's final
  message. A worker never told to write them finishes the job and lands
  `blocked / unverified`.
- **"the final non-empty line".** The markers are matched at the end of the
  output. Drop that sentence and a worker's closing summary buries its own
  sign-off.
- **Whether questions are allowed.** Dispatching with `allowQuestions: false`
  replaces the question marker with an instruction to report blocked instead.
  That is the caller's decision per task, not the project's.
- **The scope line.** It is the only place a worker learns what it may read and
  write. Without it, a sandbox denial arrives as a bare "operation not
  permitted" and the worker retries into it.
- **Where the rules sit.** Configured rules are always printed above the status
  lines, inside `<inter_protocol>`. A rule that says "never emit INTER_RESULT"
  is a rule the worker may follow, but it cannot delete the instruction that
  follows it.

Rules govern what the worker does and what it writes back. The envelope around
them is Inter's.

## Precedence

Keys merge with the defaults one at a time. Setting `report` leaves `tldr` at
`true`; setting `tldr_sentences` leaves `conduct` empty. There is no
all-or-nothing mode — a project that adds one report rule should not silently
lose the TL;DR requirement it never mentioned.

Within a key, what the project writes is the whole list, and it replaces a user
file's list rather than adding to it. The rules Inter ships are the exception:
they are not part of `conduct` or `report`, so a project writing either keeps
them and is numbered after them. Three switches remove built-in text —
`tldr = false` for the TL;DR rule, `builtins = false` for the rest, and both for
a preamble carrying only what you wrote.

## When the config is wrong

A `[worker]` table Inter cannot read fails the `delegate` call, and the error
names the file and the exact key:

```
invalid worker rules /Users/you/project/.inter.toml at worker.tldr_sentences: must be a count like "2" or a range like "1-3"
```

This is the same convention `[routes]` already follows. Nothing falls back to
defaults quietly — a rule you wrote and Inter ignored is worse than a dispatch
that stops and tells you why. The failure happens before the task is created,
so nothing is spent and nothing needs cancelling.

A missing `.inter.toml`, or one with no `[worker]` table, is not an error. That
is the normal case and it uses the defaults.
