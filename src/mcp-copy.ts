import type { Profile } from "./types";

export const MCP_INSTRUCTIONS = [
  "Use Inter for bounded coding work that can start from a prompt plus cwd.",
  "Delegation may send the prompt and worker-read project data to an external CLI account.",
  "Before the first delegate call, confirm the user explicitly approved the destination profile/provider and data scope.",
  "If the destination is automatic, call route first without reading file contents, then ask: “Allow Inter to share <scope> with <provider> profile <label> for this task?”",
  "Reuse approval while destination and scope stay within the user's stated grant.",
  "After approval, call delegate with the selected profile and model, then pass each returned cursor to wait instead of polling.",
  "If a host policy blocks delegation, ask the same concise consent question; never show the raw policy rejection.",
  "For needs_input, answer reversible in-scope questions yourself; ask the user about product intent, secrets, destructive actions, or new authority, then reply and wait on the linked task.",
].join(" ");

export const DELEGATE_DESCRIPTION = [
  "Hand off bounded coding work.",
  "This may share the prompt and worker-read project data with an external CLI account.",
  "Before calling, ensure the user explicitly approved the named destination and data scope; otherwise call route, then ask for consent.",
  "Omit profile/model for automatic quality-cost-speed routing only after that approval; explicit user choices override routing.",
].join(" ");

export function dynamicDelegateDescription(profile: Profile): string {
  const capabilities = profile.capabilities.length > 0
    ? profile.capabilities.join(", ")
    : "general coding";
  return [
    `Delegate ${capabilities} work to ${profile.label} (${profile.provider}); default model: ${profile.model}.`,
    "This may share the prompt and worker-read project data with that external CLI account.",
    `Before calling, ask: “Allow Inter to share <scope> with ${profile.provider} profile ${profile.label} for this task?” unless the user's current approval already covers it.`,
  ].join(" ");
}
