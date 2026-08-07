import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadProfilesFor, resolveProfiles, type ProfileSource } from "../src/config";
import { loadTomlLayers, TomlConfigError, type TomlLayer } from "../src/inter-toml";
import { loadRoutingPolicy, routeForTask, type RoutingPolicy, RoutingPolicyError } from "../src/routing-policy";
import { closeStateStore, stateStore } from "../src/store";
import { loadWorkerRules, loadMapConfig, type MapConfig, type WorkerRules, WorkerRulesError } from "../src/worker-config";
import type { Profile } from "../src/types";

const base: Profile[] = [
  { id: "claude", label: "Claude", provider: "claude", model: "sonnet", enabled: true, env: {}, capabilities: [] },
  { id: "opencode", label: "OpenCode", provider: "opencode", model: "deepseek", enabled: true, env: {}, capabilities: [] },
  { id: "pi", label: "Pi", provider: "pi", model: "deepseek", enabled: true, env: {}, capabilities: [] },
];

function layer(path: string, source: string): TomlLayer {
  return { path, root: Bun.TOML.parse(source) as Record<string, unknown> };
}

function sourceOf(chain: { sources: Map<string, ProfileSource> }, id: string): ProfileSource {
  return chain.sources.get(id)!;
}

describe("profile chain precedence", () => {
  test("a project file overrides the user file, which overrides the defaults", () => {
    const chain = resolveProfiles(base, layer("/p/.inter.toml", `
[profiles.claude]
model = "opus"
`), layer("/home/.inter.toml", `
[profiles.claude]
label = "User Claude"
`));

    const claude = chain.profiles.find(({ id }) => id === "claude")!;
    expect(claude.label).toBe("User Claude");
    expect(claude.model).toBe("opus");
    expect(claude.provider).toBe("claude");
    expect(sourceOf(chain, "claude")).toEqual({
      source: "/p/.inter.toml",
      sources: ["/p/.inter.toml", "/home/.inter.toml"],
    });
  });

  test("the user file overrides a stored profile field by field", () => {
    const chain = resolveProfiles(base, undefined, layer("/home/.inter.toml", `
[profiles.claude]
label = "User Claude"
[profiles.opencode]
enabled = false
[profiles.pi]
model = "deepseek-v4-pro"
`));

    expect(chain.profiles.map(({ id }) => id)).toEqual(["claude", "opencode", "pi"]);
    const claude = chain.profiles.find(({ id }) => id === "claude")!;
    expect(claude.label).toBe("User Claude");
    expect(claude.model).toBe("sonnet");
    expect(chain.profiles.find(({ id }) => id === "opencode")?.enabled).toBe(false);
    expect(chain.profiles.find(({ id }) => id === "pi")?.model).toBe("deepseek-v4-pro");
    expect(sourceOf(chain, "claude").source).toBe("/home/.inter.toml");
    expect(sourceOf(chain, "claude").sources).toEqual(["/home/.inter.toml"]);
  });

  test("all three layers present: project field wins, user-only fields survive", () => {
    const chain = resolveProfiles(base, layer("/p/.inter.toml", `
[profiles.claude]
model = "opus"
[profiles.opencode]
label = "Project OpenCode"
[profiles.pi]
`), layer("/home/.inter.toml", `
[profiles.claude]
label = "User Claude"
[profiles.opencode]
model = "opencode-go/deepseek-v4-flash"
[profiles.pi]
label = "User Pi"
enabled = false
`));

    expect(chain.profiles.map(({ id }) => id)).toEqual(["claude", "opencode", "pi"]);
    const claude = chain.profiles.find(({ id }) => id === "claude")!;
    expect(claude.label).toBe("User Claude");
    expect(claude.model).toBe("opus");
    const opencode = chain.profiles.find(({ id }) => id === "opencode")!;
    expect(opencode.label).toBe("Project OpenCode");
    expect(opencode.model).toBe("opencode-go/deepseek-v4-flash");
    const pi = chain.profiles.find(({ id }) => id === "pi")!;
    expect(pi.label).toBe("User Pi");
    expect(pi.enabled).toBe(false);
  });

  test("a field both files write comes from the higher file", () => {
    const chain = resolveProfiles(base, layer("/p/.inter.toml", `
[profiles.claude]
model = "opus"
`), layer("/home/.inter.toml", `
[profiles.claude]
model = "sonnet"
`));
    expect(chain.profiles.find(({ id }) => id === "claude")?.model).toBe("opus");
  });

  test("a layer's [profiles] table takes over the list; ids it omits are disabled", () => {
    const chain = resolveProfiles(base, layer("/p/.inter.toml", `
[profiles.claude]
model = "opus"
`), undefined);

    expect(chain.profiles.map(({ id }) => id)).toEqual(["claude"]);
    expect(chain.excluded).toEqual([
      { id: "opencode", by: "/p/.inter.toml" },
      { id: "pi", by: "/p/.inter.toml" },
    ]);
  });

  test("a project may disable one profile while the user table keeps the rest", () => {
    const chain = resolveProfiles(base, layer("/p/.inter.toml", `
[profiles.claude]
[profiles.opencode]
[profiles.pi]
enabled = false
`), layer("/home/.inter.toml", `
[profiles.claude]
[profiles.opencode]
[profiles.pi]
`));

    expect(chain.profiles.map(({ id }) => id)).toEqual(["claude", "opencode", "pi"]);
    expect(chain.profiles.find(({ id }) => id === "pi")?.enabled).toBe(false);
    expect(chain.profiles.find(({ id }) => id === "claude")?.enabled).toBe(true);
    expect(chain.excluded).toEqual([]);
  });

  test("with no config files the defaults pass through untouched", () => {
    const chain = resolveProfiles(base, undefined, undefined);
    expect(chain.profiles).toEqual(base);
    expect(chain.excluded).toEqual([]);
    expect(sourceOf(chain, "claude").source).toBe("defaults");
  });

  test("a file may introduce a profile no lower layer has", () => {
    const chain = resolveProfiles(base, undefined, layer("/home/.inter.toml", `
[profiles.work-claude]
provider = "claude"
model = "opus"
label = "Work Claude"
`));

    const work = chain.profiles.find(({ id }) => id === "work-claude")!;
    expect(work).toEqual({
      id: "work-claude",
      label: "Work Claude",
      provider: "claude",
      model: "opus",
      enabled: true,
      env: {},
      capabilities: [],
    });
  });

  test("a file-only profile without a provider is a validation error naming the file", () => {
    expect(() => resolveProfiles(base, undefined, layer("/home/.inter.toml", `
[profiles.mystery]
model = "opus"
`))).toThrow(/no profile named mystery exists below/);
  });
});

describe("profile chain validation", () => {
  test("an unknown field names the file and entry", () => {
    expect(() => resolveProfiles(base, undefined, layer("/home/.inter.toml", `
[profiles.claude]
tier = "ultra"
`))).toThrow(/invalid profile config \/home\/\.inter\.toml at profiles\.claude\.tier/);
  });

  test("a dotted profile id nests and is rejected at the nested entry", () => {
    expect(() => resolveProfiles(base, undefined, layer("/home/.inter.toml", `
[profiles.work.claude]
provider = "claude"
`))).toThrow(/invalid profile config \/home\/\.inter\.toml at profiles\.work\.claude/);
  });
});

describe("routing policy chain", () => {
  test("the user file's routes apply where the project says nothing", async () => {
    const { policy, userPath } = await routingPolicyWith(undefined, `
version = 1
[routes.build]
preference = "quality"
allow = [{ provider = "claude", model = "opus" }]
`);
    expect(policy?.path).toBe(userPath);
    expect(policy?.sources).toEqual([userPath]);
    expect(routeForTask(policy!, "build")).toEqual({
      preference: "quality",
      allow: [{ provider: "claude", model: "opus" }],
    });
  });

  test("the project route replaces the allow list and keeps the user's scalars", async () => {
    const { policy, projectPath, userPath } = await routingPolicyWith(`
version = 1
[routes.build]
allow = [{ provider = "pi", model = "opencode-go/*" }]
`, `
version = 1
[routes.build]
preference = "quality"
min_quality = 4
allow = [{ provider = "claude", model = "opus" }]
[routes.reasoning]
allow = [{ provider = "claude", model = "opus" }]
`);
    expect(policy?.path).toBe(projectPath);
    expect(policy?.sources).toEqual([projectPath, userPath]);
    expect(routeForTask(policy!, "build")).toEqual({
      preference: "quality",
      minQuality: 4,
      allow: [{ provider: "pi", model: "opencode-go/*" }],
    });
    expect(routeForTask(policy!, "reasoning")).toEqual({
      allow: [{ provider: "claude", model: "opus" }],
    });
  });
});

describe("worker rules chain", () => {
  test("a project table overrides only the keys it writes", async () => {
    const { rules } = await workerRulesWith(`
[worker]
tldr = false
`, `
[worker]
tldr = true
tldr_sentences = "2"
conduct = ["Cite path:line."]
report = ["Report failures."]
`);
    expect(rules.tldr).toBe(false);
    expect(rules.tldrSentences).toBe("2");
    expect(rules.conduct).toEqual(["Cite path:line."]);
    expect(rules.report).toEqual(["Report failures."]);
  });

  test("a written list replaces the user's list", async () => {
    const { rules } = await workerRulesWith(`
[worker]
conduct = ["Project rule."]
`, `
[worker]
conduct = ["User rule."]
`);
    expect(rules.conduct).toEqual(["Project rule."]);
  });

  test("a user file can turn Inter's own rules off for every project under it", async () => {
    const { rules } = await workerRulesWith(`
[worker]
conduct = ["Project rule."]
`, `
[worker]
builtins = false
`);
    expect(rules.builtins).toBe(false);
    expect(rules.conduct).toEqual(["Project rule."]);
  });
});

describe("map config chain", () => {
  test("a project table overrides the user's value for the keys it writes", async () => {
    const config = await mapConfigWith(`
[map]
ship = false
ship_chars = 8000
`, `
[map]
ship_chars = 12000
lookup = false
`);
    expect(config.ship).toBe(false);
    expect(config.shipChars).toBe(8000);
    expect(config.lookup).toBe(false);
  });

  test("the user file fills keys the project does not write", async () => {
    const config = await mapConfigWith(`
[map]
ship_chars = 4000
`, `
[map]
lookup = false
describe_profile = "pi"
`);
    expect(config.ship).toBe(true);
    expect(config.shipChars).toBe(4000);
    expect(config.lookup).toBe(false);
    expect(config.describeProfile).toBe("pi");
  });

  test("no table anywhere is the shipped default", async () => {
    const config = await mapConfigWith("", "");
    expect(config).toEqual({ ship: true, shipChars: 6000, lookup: true });
  });

  test("a malformed user map table fails with the worker error type", async () => {
    const home = fakeHome();
    process.env.HOME = home;
    writeFileSync(join(home, ".inter.toml"), `
[map]
ship_chars = "six thousand"
`);
    const project = fakeProject();
    const error = await loadMapConfig(project).catch((caught) => caught);
    expect(error).toBeInstanceOf(WorkerRulesError);
    expect(String(error.message)).toContain("map.ship_chars");
  });
});

describe("chain reads from the right files", () => {
  test("loadConfig(cwd) merges the project file over the user file on disk", async () => {
    seedStore(base);
    const home = fakeHome();
    process.env.HOME = home;
    writeFileSync(join(home, ".inter.toml"), `
[profiles.claude]
label = "User Claude"
`);
    const project = fakeProject(`
[profiles.claude]
model = "opus"
`);

    const config = await loadConfig(project);
    const claude = config.profiles.find(({ id }) => id === "claude")!;
    expect(claude.label).toBe("User Claude");
    expect(claude.model).toBe("opus");
    const viaLoader = await loadProfilesFor(project);
    expect(viaLoader.find(({ id }) => id === "claude")?.model).toBe("opus");
  });

  test("loadConfig() with no cwd reads user level only", async () => {
    seedStore(base);
    const home = fakeHome();
    process.env.HOME = home;
    writeFileSync(join(home, ".inter.toml"), `
[profiles.claude]
label = "User Claude"
`);
    const config = await loadConfig();
    expect(config.profiles.find(({ id }) => id === "claude")?.label).toBe("User Claude");
  });

  test("missing files at every layer are normal, not errors", async () => {
    const home = fakeHome();
    process.env.HOME = home;
    seedStore(base);
    const project = fakeProject();
    const config = await loadConfig(project);
    expect(config.profiles).toEqual(base);
  });

  test("a malformed project file fails naming the project file", async () => {
    seedStore(base);
    const home = fakeHome();
    process.env.HOME = home;
    const project = fakeProject(`
x = "abc
`);
    await expect(loadConfig(project)).rejects.toThrow(/invalid config .*inter-proj/);
  });

  test("a malformed user file fails naming the user file", async () => {
    seedStore(base);
    const home = fakeHome();
    process.env.HOME = home;
    writeFileSync(join(home, ".inter.toml"), `
x = "abc
`);
    const project = fakeProject();
    const error = await loadConfig(project).catch((caught) => caught);
    expect(error).toBeInstanceOf(TomlConfigError);
    expect(String(error.message)).toContain(join(home, ".inter.toml"));
  });

  test("a malformed user file fails loadRoutingPolicy with its own error type", async () => {
    const home = fakeHome();
    process.env.HOME = home;
    writeFileSync(join(home, ".inter.toml"), `
version = 1
x = "abc
`);
    const project = fakeProject();
    const error = await loadRoutingPolicy(project).catch((caught) => caught);
    expect(error).toBeInstanceOf(RoutingPolicyError);
    expect(error.message).toContain(join(home, ".inter.toml"));
    expect(error.message).toContain("syntax");
  });

  test("a malformed user file fails loadWorkerRules with its own error type", async () => {
    const home = fakeHome();
    process.env.HOME = home;
    writeFileSync(join(home, ".inter.toml"), `
x = "abc
`);
    const project = fakeProject();
    const error = await loadWorkerRules(project).catch((caught) => caught);
    expect(error).toBeInstanceOf(WorkerRulesError);
    expect(error.message).toContain(join(home, ".inter.toml"));
  });

  test("loadTomlLayers skips a cwd-less read of the project file", async () => {
    const home = fakeHome();
    process.env.HOME = home;
    writeFileSync(join(home, ".inter.toml"), `
[profiles.claude]
`);
    const layers = await loadTomlLayers();
    expect(layers.user?.path).toBe(join(home, ".inter.toml"));
    expect(layers.project).toBeUndefined();
  });
});

const tempDirs: string[] = [];

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "inter-home-"));
  tempDirs.push(home);
  return home;
}

function fakeProject(source?: string): string {
  const root = mkdtempSync(join(tmpdir(), "inter-proj-"));
  tempDirs.push(root);
  if (source !== undefined) writeFileSync(join(root, ".inter.toml"), source);
  return root;
}

function seedStore(profiles: Profile[]): void {
  closeStateStore();
  const db = mkdtempSync(join(tmpdir(), "inter-db-"));
  tempDirs.push(db);
  process.env.INTER_DB = join(db, "inter.db");
  stateStore().saveProfiles(profiles);
}

async function routingPolicyWith(
  projectSource: string | undefined,
  userSource: string | undefined,
): Promise<{ policy: RoutingPolicy | undefined; projectPath: string; userPath: string }> {
  const home = fakeHome();
  process.env.HOME = home;
  const userPath = join(home, ".inter.toml");
  if (userSource !== undefined) writeFileSync(userPath, userSource);
  const projectRoot = fakeProject(projectSource);
  const policy = await loadRoutingPolicy(projectRoot);
  return { policy, projectPath: join(projectRoot, ".inter.toml"), userPath };
}

async function workerRulesWith(projectSource: string, userSource: string): Promise<{ rules: WorkerRules }> {
  const home = fakeHome();
  process.env.HOME = home;
  writeFileSync(join(home, ".inter.toml"), userSource);
  const projectRoot = fakeProject(projectSource);
  return { rules: await loadWorkerRules(projectRoot) };
}

async function mapConfigWith(projectSource: string, userSource: string): Promise<MapConfig> {
  const home = fakeHome();
  process.env.HOME = home;
  writeFileSync(join(home, ".inter.toml"), userSource);
  const projectRoot = fakeProject(projectSource);
  return loadMapConfig(projectRoot);
}

let realHome: string | undefined;

beforeEach(() => {
  realHome = process.env.HOME;
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  closeStateStore();
  delete process.env.INTER_DB;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
