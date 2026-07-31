import type { Provider } from "./types";

const DEFAULT_MODELS: Record<Provider, string> = {
  claude: "sonnet",
  codex: "gpt-5",
  opencode: "opencode/big-pickle",
  antigravity: "gemini-3.6-flash-medium",
};

export function defaultModelFor(provider: Provider): string {
  return DEFAULT_MODELS[provider];
}
