import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverProfiles } from "../src/profile-discovery";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "inter-discovery-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  roots.push(root);
  mkdirSync(home);
  mkdirSync(bin);
  return { home, bin };
}

describe("profile discovery", () => {
  test("returns no profiles when no supported agents exist", () => {
    const { home, bin } = fixture();
    expect(discoverProfiles({ home, path: bin })).toEqual([]);
  });

  test("discovers pi only from its executable, never from ~/.pi alone", () => {
    const { home, bin } = fixture();
    // The config directory outlives an uninstall, so matching on it would mint
    // a profile that dies at spawn.
    mkdirSync(join(home, ".pi"));
    expect(discoverProfiles({ home, path: bin })).toEqual([]);

    const executable = join(bin, "pi");
    writeFileSync(executable, "");
    chmodSync(executable, 0o700);
    expect(discoverProfiles({ home, path: bin })).toEqual([
      expect.objectContaining({ id: "pi", provider: "pi", model: "opencode-go/deepseek-v4-flash" }),
    ]);
  });

  test("finds installed CLIs and separate Claude accounts", () => {
    const { home, bin } = fixture();
    for (const command of ["claude", "codex", "opencode", "agy"]) {
      const executable = join(bin, command);
      writeFileSync(executable, "");
      chmodSync(executable, 0o700);
    }
    mkdirSync(join(home, ".claude-work"));
    mkdirSync(join(home, ".claude_personal"));

    expect(discoverProfiles({ home, path: bin })).toEqual([
      expect.objectContaining({ id: "claude", provider: "claude", env: {} }),
      expect.objectContaining({
        id: "claude-work",
        provider: "claude",
        env: { CLAUDE_CONFIG_DIR: "$HOME/.claude-work" },
      }),
      expect.objectContaining({ id: "codex", provider: "codex" }),
      expect.objectContaining({ id: "opencode", provider: "opencode" }),
      expect.objectContaining({
        id: "antigravity",
        provider: "antigravity",
        model: "gemini-3.6-flash-medium",
      }),
    ]);
  });

  test("finds configured agents without requiring a CLI on PATH", () => {
    const { home, bin } = fixture();
    mkdirSync(join(home, ".codex"));
    mkdirSync(join(home, ".gemini"));
    mkdirSync(join(home, ".config/opencode"), { recursive: true });

    expect(discoverProfiles({ home, path: bin }).map(({ id }) => id))
      .toEqual(["codex", "opencode", "antigravity"]);
  });
});
