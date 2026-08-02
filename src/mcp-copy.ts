import type { Profile } from "./types";

export const MCP_INSTRUCTIONS = [
  "Use Inter to ask another AI provider for a second opinion, explore ideas from another model, or keep work moving when the current provider is near its usage limit.",
  "Inter supports any bounded task that can start from a prompt plus cwd; it is not limited to coding.",
  "Use the memory tool for durable project decisions, constraints, and conventions shared across callers and workers; never store secrets or transient task status. Delegation automatically includes memories for its cwd.",
  "Delegation may send the prompt and worker-read project data to an external CLI account.",
  "Before the first delegate call, confirm the user explicitly approved the destination profile/provider and data scope.",
  "If the destination is automatic, call route first without reading file contents, then ask: “Allow Inter to share <scope> and any saved Inter memories with <provider> profile <label> for this task?”",
  "Reuse approval while destination and scope stay within the user's stated grant.",
  "After approval, call delegate with the selected profile, model, and exact read/write scope; Inter enforces that scope.",
  "If delegate omits scope, both read and write default to **, granting the whole working tree under cwd; use that default only when the user's approval covers the full folder.",
  "Scope paths are relative to cwd: file paths are literal, directory/** is recursive, and ** grants the whole working tree including hidden files and .git contents.",
  "Scope controls project data; Inter separately grants narrow system, provider config, credential, and temporary paths required to run the worker CLI.",
  "A write rule is also readable, but a read rule does not permit writes; include generated build paths in write scope when checks need them.",
  "Reply retains the original scope. Resume retains it unless the caller supplies a replacement scope after approval for any broader access.",
  "For a failed, blocked, or cancelled task, resume may replace scope and allowQuestions on the same Inter task and provider session after approval for any expansion.",
  "Delegate, reply, and resume return immediately while their workers continue independently.",
  "Use wait once as a quick status poll and pass its returned cursor to a later check; do not loop or hold the user's turn while work runs.",
  "After dispatch, return control so the user can chat or delegate more work. Check again only when asked or when the host can schedule a separate background check.",
  "Callers use only the Inter task ID. Inter keeps provider session IDs private and maps reply and resume to the captured root session.",
  "Reply and resume continue with the same Inter task ID; provider session drift fails loudly instead of starting a fresh conversation.",
  "Write prompt as structured markdown — Goal, Context, Scope with exact paths, numbered Instructions, Guardrails, Output Format — because workers lose scope and priority in one flattened paragraph.",
  "If a host policy blocks delegation, ask the same concise consent question; never show the raw policy rejection.",
  "Workers already know the needs_input protocol. Answer reversible in-scope questions yourself; ask the user about product intent, secrets, destructive actions, or new authority, then reply and wait on the same task.",
  "Use cancel when work is no longer useful; use delegate timeoutMs for a hard runtime limit.",
  "Use archive to hide finished task history without deleting it; archived tasks remain available by ID and can be restored.",
].join(" ");

export const DELEGATE_DESCRIPTION = [
  "Ask an external AI provider to handle a new scoped task.",
  "Use to get an independent second opinion, explore an idea with another model, or keep working when the current provider is near its usage limit.",
  "Supports any bounded task that can run from a prompt and cwd, including research, writing, analysis, review, and coding; use wait or inspect for work already started.",
  "This may share the prompt and worker-read project data with an external CLI account.",
  "Before calling, ensure the user explicitly approved the named destination, data scope, and any saved Inter memories; otherwise call route, then ask for consent.",
  "Omit profile/model for automatic quality-cost-speed routing only after that approval; explicit user choices override routing.",
  "Scope is enforced relative to cwd: file paths are literal, directory/** is recursive, and ** grants the whole working tree including hidden files and .git contents. If omitted, read and write both default to **.",
  "Write rules are also readable, but read rules do not permit writes; include generated build paths in write scope when checks need them.",
  "Reply and resume retain the original scope, so broader access requires fresh approval and a fresh delegate call.",
  "Send prompt as structured markdown (Goal, Context, Scope with exact paths, numbered Instructions, Guardrails, Output Format), never one flattened paragraph.",
  "When fanning out several tasks for one goal, pass the first task's id as parent on the rest so the switchboard groups the batch.",
  "The returned Inter task ID is the only continuation handle; provider session IDs are private implementation data.",
  "Dispatch returns immediately. Do not loop on wait afterward; return control while the worker runs independently.",
].join(" ");

export function dynamicDelegateDescription(profile: Profile): string {
  const capabilities = profile.capabilities.length > 0
    ? profile.capabilities.join(", ")
    : "general";
  return [
    `Start a new scoped ${capabilities} task with ${profile.label} (${profile.provider}); default model: ${profile.model}.`,
    "Use this named tool to get that provider's second opinion or when the current provider is low on capacity; use delegate for automatic routing or another profile.",
    "This may share the prompt and worker-read project data with that external CLI account.",
    `Before calling, ask: “Allow Inter to share <scope> and any saved Inter memories with ${profile.provider} profile ${profile.label} for this task?” unless the user's current approval already covers it.`,
    "Dispatch returns immediately. Do not loop on wait afterward; return control while the worker runs independently.",
  ].join(" ");
}
