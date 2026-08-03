import type { Provider } from "./types";

const DEFAULT_MODELS: Record<Provider, string> = {
  claude: "sonnet",
  codex: "gpt-5",
  opencode: "opencode/big-pickle",
  antigravity: "gemini-3.6-flash-medium",
  // pi resolves a bare id against the first catalog entry that matches, so the
  // provider-qualified form is the only unambiguous way to name a model.
  pi: "opencode-go/deepseek-v4-flash",
};

export function defaultModelFor(provider: Provider): string {
  return DEFAULT_MODELS[provider];
}
