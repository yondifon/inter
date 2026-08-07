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
  loadProfiles(cwd?: string): Promise<Profile[]>;
  listModels(query: ModelQuery): Promise<ModelInfo[]>;
  listProfileFailures(): ProfileFailure[];
  listProfileSuccesses(): ProfileSuccess[];
  now(): Date;
}

const dependencies: ProfileStatusDependencies = {
  loadProfiles: async (cwd) => (await loadConfig(cwd)).profiles,
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
    deps.loadProfiles(query.cwd),
    deps.listModels({
      ...(query.profile ? { profile: query.profile } : {}),
      ...(query.provider ? { provider: query.provider } : {}),
      ...(query.refresh !== undefined ? { refresh: query.refresh } : {}),
      ...(query.cwd ? { cwd: query.cwd } : {}),
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
    const success = successByProfile.get(profile.id);
    const failure = applicableFailure(failureByProfile.get(profile.id), model.id, success);
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

/**
 * Which recorded failure still describes this model. Two things disqualify one.
 *
 * A run that succeeded after the failure was recorded is later evidence about
 * the same account, so the failure no longer describes it: the settle path
 * clears the row on a normal completion, but a task completed any other way —
 * asserted, force-settled, completed while the broker was down — leaves it
 * behind, and without this the profile reads as broken forever.
 *
 * A rate limit belongs to the model that hit it. Providers meter per model, so
 * one exhausted model says nothing about the account's other models; auth and
 * billing are credentials, and network is the host, so both stay account-wide.
 */
function applicableFailure(
  failure: ProfileFailure | undefined,
  model: string,
  success: ProfileSuccess | undefined,
): ProfileFailure | undefined {
  if (!failure) return undefined;
  if (success && Date.parse(success.succeededAt) > Date.parse(failure.failedAt)) return undefined;
  if (failure.code !== "rate_limit" || !failure.model) return failure;
  return failure.model === model ? failure : undefined;
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
  if (failure?.code === "network") {
    const retryAt = failure.retryAt ??
      new Date(Date.parse(failure.failedAt) + 5 * 60_000).toISOString();
    if (Date.parse(retryAt) > Date.parse(normalizedAt)) {
      return {
        state: "unavailable",
        source: "task",
        reason: `Observed network failure: ${failure.message}`,
        checkedAt: failure.failedAt,
        retryAt,
      };
    }
    return {
      state: "unknown",
      source: "task",
      reason: `Network retry time passed; availability has not been rechecked (was: ${failure.message})`,
      checkedAt: failure.failedAt,
      retryAt,
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
