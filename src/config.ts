import { homedir } from "node:os";
import type { Config, Profile } from "./types";
import { stateStore } from "./store";

export async function loadConfig(): Promise<Config> {
  return { profiles: stateStore().listProfiles() };
}

export async function saveConfig(config: Config): Promise<void> {
  stateStore().saveProfiles(config.profiles);
}

export function profileEnv(profile: Profile): Record<string, string> {
  const home = process.env.HOME ?? homedir();
  return Object.fromEntries(Object.entries(profile.env).map(([key, value]) => [
    key,
    value.replace(/^\$HOME(?=\/|$)/, home).replace(/^~(?=\/|$)/, home),
  ]));
}
