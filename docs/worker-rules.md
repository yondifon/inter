# Worker rules (`[worker]`)

Every task Inter dispatches ships with a preamble wrapped around the caller's
prompt: the scope line, the rules the worker should follow, and the status lines
it must sign off with. Most of that preamble is machinery — Inter reads those
lines back out of the worker's final message. The rules are not. They were one
person's preferences hardcoded into the source, and a project can now set its
own in `.inter.toml`.

## What a project can set

```toml
version = 1

[worker]
tldr = true
tldr_sentences = "2-4"
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
| `conduct` | array of strings | none | How the worker should work. Shown as its own numbered section, before the report rules. |
| `report` | array of strings | none | How the worker should report back. Numbered after the TL;DR rule. |

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
1. Run `bun test` before you report, and paste the tally.
2. Never write files with shell redirects; use your editing tools.

## User rules
The rules below are set by your user and apply to every delegation. Honor them for your final report.
1. Open your final report with `## TL;DR` — 2-4 plain-language sentences stating what was done or found and the outcome. Detail follows after; this applies to your final answer, not to intermediate messages.
2. Cite every claim about the code as path:line.
3. List the files you changed, one per line, before any prose.
If a product choice, secret, destructive action, or new authority is required, stop and end with: INTER_NEEDS_INPUT: <one clear question>
If the requested work is fully done, end with: INTER_RESULT: completed
If work cannot be completed, end with: INTER_BLOCKED: <permission_denied|needs_authority|worker_error> | <short reason>
Emit exactly one of those status lines as the final non-empty line of your final message. Do not claim completion before the work is done.
</inter_protocol>
```

Set nothing and you get today's preamble unchanged: the TL;DR rule at `1-3`
sentences and no `## How to work` section at all. A section with no rules in it
prints no heading.

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

Within a key, what the project writes is the whole list. `report` does not
append to a hidden built-in list, because there isn't one: the only built-in
rule is the TL;DR rule, and `tldr = false` is how you remove it.

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
