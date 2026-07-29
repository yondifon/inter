import type { Profile } from "./types";

export interface DynamicProfileTool {
  name: string;
  profile: Profile;
}

export function dynamicProfileTools(profiles: Profile[]): DynamicProfileTool[] {
  const used = new Set(["delegate", "inspect", "reply", "profiles", "models"]);
  return profiles.filter(({ enabled }) => enabled).map((profile) => {
    const base = `${toolSlug(profile.id)}_delegate`;
    let name = base;
    if (used.has(name)) name = `${base}_${shortHash(profile.id)}`;
    while (used.has(name)) name = `${name}_2`;
    used.add(name);
    return { name, profile };
  });
}

function toolSlug(value: string): string {
  const slug = value.toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48)
    .replace(/_+$/g, "");
  return slug || `profile_${shortHash(value)}`;
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}
