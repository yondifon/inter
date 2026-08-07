import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessStaleness, computeStaleness, stampSha } from "../src/staleness";

function git(...args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (!proc.success) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

function repoWithCommit(): { root: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), "inter-stale-"));
  git("init", "-q", root);
  writeFileSync(join(root, "seed.txt"), "seed");
  git("-C", root, "add", "seed.txt");
  git("-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "seed");
  return { root, sha: git("-C", root, "rev-parse", "--short", "HEAD") };
}

describe("stampSha", () => {
  test("extracts the sha from a baked stamp", () => {
    expect(stampSha("428c92d-20260807000000")).toBe("428c92d");
  });

  test("is undefined for the dev stamp", () => {
    expect(stampSha("dev")).toBeUndefined();
  });
});

describe("assessStaleness", () => {
  test("is stale only when the source sha moved past the running stamp", () => {
    expect(assessStaleness("428c92d-20260807000000", "428c92d")).toEqual({ stale: false });
    expect(assessStaleness("428c92d-20260807000000", "5c001ed").stale).toBe(true);
    expect(assessStaleness("dev", "428c92d")).toEqual({ stale: false });
    expect(assessStaleness("428c92d-20260807000000", undefined)).toEqual({ stale: false });
  });
});

describe("computeStaleness", () => {
  test("finds the source tree by walking up from the compiled binary's location", () => {
    const { root, sha } = repoWithCommit();
    const binary = join(root, "dist", "inter-server");
    expect(computeStaleness(binary, "abc1234-20260807000000")).toMatchObject({ stale: true, currentSha: sha });
    expect(computeStaleness(binary, `${sha}-20260807000000`)).toEqual({ stale: false });
  });

  test("finds the source tree from an installed bundle's Info.plist", () => {
    const { root, sha } = repoWithCommit();
    const bundle = mkdtempSync(join(tmpdir(), "inter-bundle-"));
    mkdirSync(join(bundle, "Contents"), { recursive: true });
    writeFileSync(
      join(bundle, "Contents", "Info.plist"),
      `<plist><dict><key>InterRepoPath</key><string>${root}</string></dict></plist>`,
    );
    const binary = join(bundle, "Contents", "Resources", "inter-server");
    expect(computeStaleness(binary, "abc1234-20260807000000")).toMatchObject({ stale: true, currentSha: sha });
  });

  test("never reports stale when the source tree cannot be located", () => {
    const root = mkdtempSync(join(tmpdir(), "inter-norepo-"));
    expect(computeStaleness(join(root, "bin", "inter-server"), "abc1234-20260807000000")).toEqual({ stale: false });
  });

  test("never reports stale for a dev stamp", () => {
    const { root } = repoWithCommit();
    expect(computeStaleness(join(root, "dist", "inter-server"), "dev")).toEqual({ stale: false });
  });
});
