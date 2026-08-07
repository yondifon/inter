import { maskSecretEnv } from "./config";
import type { Profile } from "./types";

/**
 * The full profile the app reads and writes: masked env, launch overrides,
 * everything Settings edits. HTTP profile routes only — this is also the
 * app's on-disk shape, so trimming it here would break the Settings screen.
 */
export function publicProfile(profile: Profile): Profile {
  return {
    ...profile,
    env: maskSecretEnv(profile.env),
  };
}

export function publicProfiles(profiles: Profile[]): Profile[] {
  return profiles.map(publicProfile);
}

export type CallerProfile = Pick<Profile, "id" | "label" | "provider" | "model" | "enabled" | "capabilities">;

/**
 * What an MCP caller needs to pick a destination. `env` and `command` are
 * host launch config the broker alone reads — a caller cannot act on either,
 * so neither belongs on this surface.
 */
export function profileForCaller(profile: Profile): CallerProfile {
  const { id, label, provider, model, enabled, capabilities } = profile;
  return { id, label, provider, model, enabled, capabilities };
}

export function profilesForCaller(profiles: Profile[]): CallerProfile[] {
  return profiles.map(profileForCaller);
}
