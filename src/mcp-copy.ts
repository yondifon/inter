// Kept short on purpose. A long preamble gets skimmed, so anything a caller
// must not get wrong lives in the per-parameter descriptions instead.
export const MCP_INSTRUCTIONS = [
  "Inter hands a bounded task to a different AI provider's CLI account — for a second opinion, for capacity when this provider is near its limit, or for work this provider's policy will not take. Any task that starts from a prompt plus a cwd qualifies; it is not limited to coding.",
  "Delegation sends the prompt, the cwd's saved memories, and whatever the worker reads to an external account. Get the user's approval for the destination and the data before the first delegate, and ask again when either moves outside what they agreed to.",
  "Scope is what the worker may touch. State it on delegate and Inter records it as a grant on that cwd for that profile; omit it and Inter reuses the newest grant for the cwd. Reusing a scope approved for a different profile still runs, but returns a warning — approval names a destination, not only a folder. Only a cwd with no grant at all falls back to the whole tree, and that task is flagged too.",
  "Callers hold only the Inter task ID; provider session IDs stay private. Reply answers a needs_input question, resume retries a failed, blocked, or cancelled task, and both continue the same task ID and provider session.",
  "Dispatch returns immediately. Poll with wait, read a task in full with inspect, and return control between checks instead of looping while a worker runs.",
  "Answer a worker's reversible in-scope questions yourself; bring product intent, secrets, destructive actions, and requests for new authority to the user.",
].join(" ");

export const DELEGATE_DESCRIPTION = [
  "Ask an external AI provider to handle a new scoped task.",
  "Use to get an independent second opinion, explore an idea with another model, or keep working when the current provider is near its usage limit.",
  "Supports any bounded task that can run from a prompt and cwd, including research, writing, analysis, review, and coding; use wait or inspect for work already started.",
  "This may share the prompt and worker-read project data with an external CLI account.",
  "Before calling, ensure the user explicitly approved the named destination, data scope, and any saved Inter memories; otherwise call route, then ask for consent.",
  "Omit profile/model for automatic quality-cost-speed routing only after that approval; explicit user choices override routing.",
  "Scope is enforced relative to cwd: file paths are literal, directory/** is recursive, and ** grants the whole working tree including hidden files and .git contents.",
  "Stating scope records it as this cwd's grant; omitting it reuses the newest grant for that cwd, and only falls back to ** when the cwd has no grant at all — a task that lands on that fallback is flagged.",
  "Write rules are also readable, but read rules do not permit writes; include generated build paths in write scope when checks need them.",
  "Reply retains the task's scope; resume may replace it after fresh approval, and the replacement becomes the cwd's grant.",
  "Send prompt as structured markdown (Goal, Context, Scope with exact paths, numbered Instructions, Guardrails, Output Format), never one flattened paragraph.",
  "When fanning out several tasks for one goal, pass the first task's id as parent on the rest so the switchboard groups the batch.",
  "The returned Inter task ID is the only continuation handle; provider session IDs are private implementation data.",
  "Dispatch returns immediately. Do not loop on wait afterward; return control while the worker runs independently.",
].join(" ");
