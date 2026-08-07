import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoutingPolicy } from "../src/routing-policy";
import { DEFAULT_WORKER_RULES, loadWorkerRules, WorkerRulesError } from "../src/worker-config";

const roots: string[] = [];

// Worker rules and routing policy both read `~/.inter.toml` as their user
// layer, so an empty temp home keeps these tests off the machine's dotfiles.
const realHome = process.env.HOME;
beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "inter-worker-home-"));
  roots.push(home);
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = realHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loadWorkerRules", () => {
  test("returns the shipped defaults when the project has no config file", async () => {
    expect(await loadWorkerRules(tempProject())).toEqual(DEFAULT_WORKER_RULES);
  });

  test("returns the shipped defaults when the config file has no worker table", async () => {
    const root = projectWith(`
version = 1
[routes.build]
allow = [{ provider = "claude", model = "opus" }]
`);
    expect(await loadWorkerRules(root)).toEqual(DEFAULT_WORKER_RULES);
  });

  test("reads every key", async () => {
    const root = projectWith(`
[worker]
tldr = true
tldr_sentences = "2-4"
tldr_template = "Say hi — {count}."
builtins = false
conduct = ["Run bun test before reporting."]
report = ["Cite code as path:line.", "  No tables.  "]
`);
    expect(await loadWorkerRules(root)).toEqual({
      tldr: true,
      tldrSentences: "2-4",
      tldrTemplate: "Say hi — {count}.",
      builtins: false,
      conduct: ["Run bun test before reporting."],
      report: ["Cite code as path:line.", "No tables."],
    });
  });

  test("keeps the defaults for keys the project leaves out", async () => {
    expect(await loadWorkerRules(projectWith(`[worker]\nreport = ["Answer in French."]`))).toEqual({
      ...DEFAULT_WORKER_RULES,
      report: ["Answer in French."],
    });
    expect(await loadWorkerRules(projectWith(`[worker]\ntldr = false`))).toEqual({
      ...DEFAULT_WORKER_RULES,
      tldr: false,
    });
    expect(await loadWorkerRules(projectWith(`[worker]\ntldr_template = "Custom — {count}."`))).toEqual({
      ...DEFAULT_WORKER_RULES,
      tldrTemplate: "Custom — {count}.",
    });
    expect(await loadWorkerRules(projectWith(`[worker]\nbuiltins = false`))).toEqual({
      ...DEFAULT_WORKER_RULES,
      builtins: false,
    });
  });

  test("ships Inter's own rules unless the project turns them off", async () => {
    expect(DEFAULT_WORKER_RULES.builtins).toBe(true);
    expect((await loadWorkerRules(projectWith(`[worker]\nconduct = ["Be brief."]`))).builtins).toBe(true);
  });

  test("accepts a bare sentence count and normalizes it", async () => {
    expect((await loadWorkerRules(projectWith(`[worker]\ntldr_sentences = " 2 "`))).tldrSentences).toBe("2");
  });

  test("names the file and the key on a malformed value", async () => {
    const root = projectWith(`[worker]\ntldr = "yes"`);
    const error = await loadWorkerRules(root).catch((caught) => caught);
    expect(error).toBeInstanceOf(WorkerRulesError);
    expect(error.message).toContain(join(root, ".inter.toml"));
    expect(error.message).toContain("worker.tldr");
    expect(error.message).toContain("must be true or false");
  });

  test.each([
    [`[worker]\ntldr = "yes"`, "worker.tldr"],
    [`[worker]\nbuiltins = "no"`, "worker.builtins"],
    [`[worker]\nreports = ["x"]`, "worker.reports"],
    [`[worker]\ntldr_sentences = 3`, "worker.tldr_sentences"],
    [`[worker]\ntldr_sentences = "many"`, "worker.tldr_sentences"],
    [`[worker]\ntldr_sentences = "5-2"`, "worker.tldr_sentences"],
    [`[worker]\ntldr_template = 3`, "worker.tldr_template"],
    [`[worker]\ntldr_template = "  "`, "worker.tldr_template"],
    [`[worker]\ntldr_template = "no placeholder here"`, "worker.tldr_template"],
    [`[worker]\ntldr_template = "${"x".repeat(495)}{count}"`, "worker.tldr_template"],
    [`[worker]\ntldr_template = """one\ntwo {count}"""`, "worker.tldr_template"],
    [`[worker]\nreport = "Be brief."`, "worker.report"],
    [`[worker]\nreport = ["Be brief.", ""]`, "worker.report[1]"],
    [`[worker]\nreport = ["Be brief.", 7]`, "worker.report[1]"],
    [`[worker]\nconduct = ["""one\ntwo"""]`, "worker.conduct[0]"],
    [`worker = "strict"`, "worker"],
  ])("rejects a malformed worker table", async (source, field) => {
    const error = await loadWorkerRules(projectWith(source)).catch((caught) => caught);
    expect(error).toBeInstanceOf(WorkerRulesError);
    expect(error.field).toBe(field);
  });

  test("rejects rules over the caps instead of truncating them", async () => {
    const many = Array.from({ length: 21 }, (_, index) => `"rule ${index}"`).join(", ");
    const long = "x".repeat(501);
    const bulky = Array.from({ length: 10 }, () => `"${"y".repeat(450)}"`).join(", ");

    expect((await loadWorkerRules(projectWith(`[worker]\nreport = [${many}]`)).catch((e) => e)).field)
      .toBe("worker.report");
    expect((await loadWorkerRules(projectWith(`[worker]\nreport = ["${long}"]`)).catch((e) => e)).field)
      .toBe("worker.report[0]");
    expect((await loadWorkerRules(projectWith(`[worker]\nconduct = [${bulky}]`)).catch((e) => e)).field)
      .toBe("worker.conduct");
  });

  test("reports a syntax error against the file", async () => {
    const root = projectWith(`[worker\ntldr = false`);
    const error = await loadWorkerRules(root).catch((caught) => caught);
    expect(error).toBeInstanceOf(WorkerRulesError);
    expect(error.field).toBe("syntax");
    expect(error.message).toContain(join(root, ".inter.toml"));
  });
});

describe("worker rules alongside routing policy", () => {
  test("a worker table does not break the routing policy in the same file", async () => {
    const root = projectWith(`
version = 1

[worker]
tldr = false

[routes.build]
allow = [{ provider = "claude", model = "opus" }]
`);
    expect((await loadRoutingPolicy(root))?.routes.build?.allow).toEqual([
      { provider: "claude", model: "opus" },
    ]);
    expect((await loadWorkerRules(root)).tldr).toBe(false);
  });

  test("a file that only configures the worker declares no routing policy", async () => {
    const root = projectWith(`[worker]\nreport = ["Be brief."]`);
    expect(await loadRoutingPolicy(root)).toBeUndefined();
    expect((await loadWorkerRules(root)).report).toEqual(["Be brief."]);
  });
});

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "inter-worker-rules-"));
  roots.push(root);
  return root;
}

function projectWith(source: string): string {
  const root = tempProject();
  writeFileSync(join(root, ".inter.toml"), source);
  return root;
}
