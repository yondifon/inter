import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRoutingPolicy,
  modelAllowed,
  normalizeTaskClass,
  routeForTask,
  RoutingPolicyError,
} from "../src/routing-policy";

const roots: string[] = [];

// Policy resolution reads `~/.inter.toml` as its user layer, so an empty temp
// home keeps these tests independent of the machine's real dotfiles.
const realHome = process.env.HOME;
beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "inter-policy-home-"));
  roots.push(home);
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = realHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loadRoutingPolicy", () => {
  test("returns undefined when the project has no policy", async () => {
    expect(await loadRoutingPolicy(tempProject())).toBeUndefined();
  });

  test("loads and normalizes a version 1 policy", async () => {
    const root = projectWith(`
version = 1

[routes.BUILD]
preference = "quality"
min_quality = 5
allow = [
  { provider = "Claude", model = "OPUS" },
  { provider = "OpenCode", model = "opencode-go/*" },
]
`);

    const policy = await loadRoutingPolicy(root);
    expect(policy?.version).toBe(1);
    expect(policy?.path).toBe(join(root, ".inter.toml"));
    expect(routeForTask(policy!, "build")).toEqual({
      preference: "quality",
      minQuality: 5,
      allow: [
        { provider: "claude", model: "opus" },
        { provider: "opencode", model: "opencode-go/*" },
      ],
    });
  });

  test("reports the file and exact invalid field", async () => {
    const root = projectWith(`
version = 1
[routes.build]
allow = [{ provider = "claude", model = "opus", profile = "personal" }]
`);

    const error = await loadRoutingPolicy(root).catch((caught) => caught);
    expect(error).toBeInstanceOf(RoutingPolicyError);
    expect(error.message).toContain(join(root, ".inter.toml"));
    expect(error.message).toContain("routes.build.allow[0].profile");
  });

  test.each([
    ["version = 2\n[routes.build]\nallow = [{ provider = \"claude\", model = \"opus\" }]", "version"],
    ["version = 1\n[routes.deploy]\nallow = [{ provider = \"claude\", model = \"opus\" }]", "routes.deploy"],
    ["version = 1\n[routes.build]\nallow = [{ provider = \"cl*\", model = \"opus\" }]", "routes.build.allow[0].provider"],
    ["version = 1\n[routes.build]\nallow = [{ provider = \"claude\", model = \"opus[0-9]\" }]", "routes.build.allow[0].model"],
  ])("rejects invalid policy fields", async (source, field) => {
    const error = await loadRoutingPolicy(projectWith(source)).catch((caught) => caught);
    expect(error).toBeInstanceOf(RoutingPolicyError);
    expect(error.field).toBe(field);
  });
});

describe("policy matching", () => {
  test("matches normalized provider and full model IDs with anchored globs", async () => {
    const policy = await loadRoutingPolicy(projectWith(`
version = 1
[routes.reasoning]
allow = [
  { provider = "claude", model = "*" },
  { provider = "opencode", model = "opencode-go/*" },
]
`));
    const route = routeForTask(policy!, "REASONING")!;

    expect(modelAllowed(route, "CLAUDE", "OPUS")).toBe(true);
    expect(modelAllowed(route, "opencode", "opencode-go/kimi-k2")).toBe(true);
    expect(modelAllowed(route, "opencode", "prefix/opencode-go/kimi-k2")).toBe(false);
    expect(modelAllowed(route, "other", "opencode-go/kimi-k2")).toBe(false);
  });

  test("normalizes only supported task classes", () => {
    expect(normalizeTaskClass(" Build ")).toBe("build");
    expect(normalizeTaskClass("profile-name")).toBeUndefined();
  });
});

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "inter-policy-"));
  roots.push(root);
  return root;
}

function projectWith(source: string): string {
  const root = tempProject();
  writeFileSync(join(root, ".inter.toml"), source);
  return root;
}
