import { randomUUID } from "node:crypto";
import { defaultModelFor } from "./provider-defaults";
import type { Profile, Provider } from "./types";

export function normalizeProfile(input: unknown): Profile {
  const raw = input as Partial<Profile>;
  const providers: Provider[] = ["claude", "codex", "opencode", "antigravity"];
  if (!raw || typeof raw !== "object") throw new Error("profile must be an object");
  if (!providers.includes(raw.provider as Provider)) throw new Error("invalid provider");
  const label = String(raw.label ?? "").trim();
  const model = String(raw.model ?? "").trim() || defaultModelFor(raw.provider as Provider);
  if (!label) throw new Error("label is required");
  const id = String(raw.id || label.toLowerCase().replace(/[^a-z0-9]+/g, "-")).replace(/^-|-$/g, "");
  return {
    id: id || randomUUID(),
    label,
    provider: raw.provider as Provider,
    model,
    enabled: raw.enabled !== false,
    env: Object.fromEntries(Object.entries(raw.env ?? {}).map(([key, value]) =>
      [key.trim(), String(value)]).filter(([key]) => key)),
    capabilities: (raw.capabilities ?? []).map(String),
    ...(raw.command ? { command: raw.command.map(String) } : {}),
  };
}
