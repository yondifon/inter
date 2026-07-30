import { loadConfig } from "./config";
import { listModels, type ModelQuery } from "./models";
import {
  stateStore,
  type ProfileFailure,
  type ProfileSuccess,
} from "./store";
import type { ModelInfo, Profile, Provider } from "./types";

export type AvailabilityState = "available" | "unavailable" | "unknown";
export type AvailabilitySource = "task" | "catalog" | "configuration";

export interface ProfileStatus {
  profile: string;
  provider: Provider;
  model: string;
  state: AvailabilityState;
  source: AvailabilitySource;
  reason: string;
  checkedAt: string;
  retryAt?: string;
}

export interface ProfileStatusQuery extends ModelQuery {
  model?: string;
}

interface ProfileStatusDependencies {
  loadProfiles(): Promise<Profile[]>;
  listModels(query: ModelQuery): Promise<ModelInfo[]>;
  listProfileFailures(): ProfileFailure[];
  listProfileSuccesses(): ProfileSuccess[];
  now(): Date;
}

const dependencies: ProfileStatusDependencies = {
  loadProfiles: async () => (await loadConfig()).profiles,
  listModels,
  listProfileFailures: () => stateStore().listProfileFailures(),
  listProfileSuccesses: () => stateStore().listProfileSuccesses(),
  now: () => new Date(),
};

export async function listProfileStatuses(
  query: ProfileStatusQuery = {},
  deps: ProfileStatusDependencies = dependencies,
): Promise<ProfileStatus[]> {
  const [profiles, models] = await Promise.all([
    deps.loadProfiles(),
    deps.listModels({
      ...(query.profile ? { profile: query.profile } : {}),
      ...(query.provider ? { provider: query.provider } : {}),
      ...(query.refresh !== undefined ? { refresh: query.refresh } : {}),
    }),
  ]);
  const filteredModels = query.model
    ? models.filter(({ id }) => id === query.model)
    : models;
  return normalizeProfileStatuses(
    profiles,
    filteredModels,
    deps.listProfileFailures(),
    deps.listProfileSuccesses(),
    deps.now(),
    query.refresh === true,
  );
}

export function normalizeProfileStatuses(
  profiles: Profile[],
  models: ModelInfo[],
  failures: ProfileFailure[],
  successes: ProfileSuccess[],
  now = new Date(),
  refreshed = false,
): ProfileStatus[] {
  const profileById = new Map(profiles
    .filter(({ enabled }) => enabled)
    .map((profile) => [profile.id, profile]));
  const failureByProfile = new Map(failures.map((failure) => [failure.profileId, failure]));
  const successByProfile = new Map(successes.map((success) => [success.profileId, success]));
  const normalizedAt = now.toISOString();

  return models.flatMap((model) => {
    const profile = profileById.get(model.profileId);
    if (!profile) return [];
    const failure = failureByProfile.get(profile.id);
    const success = successByProfile.get(profile.id);
    return [{
      profile: profile.id,
      provider: profile.provider,
      model: model.id,
      ...availability(failure, success, normalizedAt, refreshed),
    }];
  }).sort((a, b) =>
    a.profile.localeCompare(b.profile) || a.model.localeCompare(b.model)
  );
}

function availability(
  failure: ProfileFailure | undefined,
  success: ProfileSuccess | undefined,
  normalizedAt: string,
  refreshed: boolean,
): Pick<ProfileStatus, "state" | "source" | "reason" | "checkedAt" | "retryAt"> {
  if (failure?.code === "auth") {
    return {
      state: "unavailable",
      source: "task",
      reason: "Observed authentication failure",
      checkedAt: failure.failedAt,
    };
  }
  if (failure?.code === "billing") {
    return {
      state: "unavailable",
      source: "task",
      reason: "Observed billing failure",
      checkedAt: failure.failedAt,
    };
  }
  if (failure?.code === "rate_limit") {
    const retryAt = failure.retryAt ??
      new Date(Date.parse(failure.failedAt) + 10 * 60_000).toISOString();
    if (Date.parse(retryAt) > Date.parse(normalizedAt)) {
      return {
        state: "unavailable",
        source: "task",
        reason: "Observed rate limit",
        checkedAt: failure.failedAt,
        retryAt,
      };
    }
    return {
      state: "unknown",
      source: "task",
      reason: "Rate-limit retry time passed; availability has not been rechecked",
      checkedAt: failure.failedAt,
      retryAt,
    };
  }
  if (success) {
    return {
      state: "available",
      source: "task",
      reason: "Observed successful generation",
      checkedAt: success.succeededAt,
    };
  }
  return {
    state: "unknown",
    source: refreshed ? "catalog" : "configuration",
    reason: refreshed
      ? "Catalog access does not confirm generation or billing availability"
      : "No observed generation outcome",
    checkedAt: normalizedAt,
  };
}
