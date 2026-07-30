import type { Profile, Provider } from "./types";

export function commandFor(profile: Profile, prompt: string, cwd: string, model = profile.model, hookUrl?: string): string[] {
  if (profile.command) {
    return profile.command.map((part) => part
      .replaceAll("{prompt}", prompt)
      .replaceAll("{model}", model)
      .replaceAll("{cwd}", cwd));
  }

  switch (profile.provider) {
    case "claude":
      return [
        "claude", "-p", "--output-format", "stream-json", "--verbose", "--model", model,
        "--permission-mode", "acceptEdits",
        ...(hookUrl ? ["--settings", claudeHookSettings(hookUrl)] : []),
        prompt,
      ];
    case "codex":
      return [
        "codex", "exec", "--json", "--model", model, "--sandbox", "workspace-write",
        "--cd", cwd, "--skip-git-repo-check", prompt,
      ];
    case "opencode":
      return ["opencode", "run", "--format", "json", "--model", model, "--dir", cwd, "--auto", prompt];
    case "antigravity":
      return ["antigravity", "--model", model, prompt];
  }
}

export function canResumeSession(profile: Profile): boolean {
  if (profile.command) return false;
  return profile.provider === "claude" || profile.provider === "codex" || profile.provider === "opencode";
}

export function resumeCommandFor(
  profile: Profile,
  prompt: string,
  cwd: string,
  sessionId: string,
  model = profile.model,
  hookUrl?: string,
): string[] {
  if (!profile.command) {
    switch (profile.provider) {
      case "claude":
        return [
          "claude", "-p", "--output-format", "stream-json", "--verbose", "--model", model,
          "--permission-mode", "acceptEdits", "--resume", sessionId,
          ...(hookUrl ? ["--settings", claudeHookSettings(hookUrl)] : []),
          prompt,
        ];
      case "codex":
        // `codex exec resume` has no --sandbox or --cd flags; sandbox comes from a
        // config override and cwd from the spawned process working directory.
        return [
          "codex", "exec", "resume", sessionId, "--json", "--model", model,
          "-c", 'sandbox_mode="workspace-write"', "--skip-git-repo-check", prompt,
        ];
      case "opencode":
        return [
          "opencode", "run", "--format", "json", "--model", model, "--dir", cwd,
          "--auto", "--session", sessionId, prompt,
        ];
    }
  }
  throw new Error(`profile cannot resume sessions: ${profile.id}`);
}

export function sessionIdFrom(provider: Provider, event: Record<string, unknown>): string | undefined {
  const value = provider === "claude" ? event.session_id
    : provider === "codex" ? event.thread_id
    : provider === "opencode" ? event.sessionID
    : undefined;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function claudeHookSettings(url: string): string {
  const handler = [{ matcher: "", hooks: [{ type: "http", url, timeout: 10 }] }];
  return JSON.stringify({
    hooks: {
      PreToolUse: handler,
      PostToolUse: handler,
      PostToolUseFailure: handler,
      SubagentStart: handler,
      SubagentStop: handler,
      Notification: handler,
      StopFailure: handler,
    },
  });
}

export function finalText(profile: Profile, raw: string): string {
  if (profile.provider === "claude") {
    const lines = raw.trim().split("\n");
    for (let index = lines.length - 1; index >= 0; index--) {
      try {
        const parsed = JSON.parse(lines[index]!) as { result?: string };
        if (typeof parsed.result === "string") return parsed.result;
      } catch {}
    }
    return raw;
  }

  const lines = raw.trim().split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const event = JSON.parse(lines[index]!) as Record<string, unknown>;
      const item = object(event.item);
      const part = object(event.part);
      const message = object(event.message);
      const text = event.text ?? event.message ?? event.content ?? event.result
        ?? item.text ?? item.message ?? part.text ?? part.message ?? message.content;
      if (typeof text === "string") return text;
    } catch {}
  }
  return raw.trim();
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
