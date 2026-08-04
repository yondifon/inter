import { describe, expect, test } from "bun:test";
import { interpretWorkerOutcome, needsInputQuestion } from "../src/task-protocol";

const done = (output: string) => interpretWorkerOutcome(0, output, "");

describe("completion marker", () => {
  // Every one of these was observed as blocked/unverified before the marker
  // accepted decoration. The worker had finished; it just signed off in
  // markdown, which the smaller models do by default.
  const decorated: Array<[string, string]> = [
    ["plain", "Done.\n\nINTER_RESULT: completed"],
    ["bold", "Done.\n\n**INTER_RESULT: completed**"],
    ["inline code", "Done.\n\n`INTER_RESULT: completed`"],
    ["fenced", "Done.\n\n```\nINTER_RESULT: completed\n```"],
    ["trailing period", "Done.\n\nINTER_RESULT: completed."],
    ["bold and period", "Done.\n\n**INTER_RESULT: completed.**"],
    ["bullet", "Done.\n\n- INTER_RESULT: completed"],
    ["bold bullet", "Done.\n\n- **INTER_RESULT: completed**"],
    ["block quote", "Done.\n\n> INTER_RESULT: completed"],
    ["heading", "Done.\n\n## INTER_RESULT: completed"],
    ["indented", "Done.\n\n    INTER_RESULT: completed"],
  ];

  for (const [label, output] of decorated) {
    test(`accepts a ${label} marker`, () => {
      expect(done(output).state).toBe("completed");
    });
  }

  test("still refuses to invent a completion when no marker is present", () => {
    const outcome = done("I finished the refactor and all tests pass.");
    expect(outcome.state).toBe("blocked");
    expect(outcome.completion.code).toBe("unverified");
  });

  test("does not fire on the instruction echoing the marker mid-sentence", () => {
    // The shipped prompt contains this sentence, and workers quote it back.
    const outcome = done("The contract says to end with: INTER_RESULT: completed when done.");
    expect(outcome.state).toBe("blocked");
  });
});

describe("blocked marker", () => {
  test("accepts decoration around the marker", () => {
    const outcome = done("**INTER_BLOCKED: permission_denied | cannot write there**");
    expect(outcome.state).toBe("blocked");
    expect(outcome.completion.code).toBe("permission_denied");
  });

  test("keeps a glob intact in the reason", () => {
    const outcome = done("INTER_BLOCKED: permission_denied | write denied on docs/**");
    expect(outcome.completion.reason).toBe("write denied on docs/**");
  });
});

/**
 * All four of these used to be one report — `unverified`, "worker exited
 * without an Inter completion marker" — so a caller could not tell a dead
 * account from a dead turn from a worker that did the job and signed off wrong
 * without opening the database.
 */
describe("a zero exit that is not a working run", () => {
  const AUTH = `401 {"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}`;
  const aborted = "the provider ended the turn mid-generation: step_finish reason \"unknown\", no output tokens";

  test("reads a provider rejection as the failure it is", () => {
    const outcome = done(AUTH);
    expect(outcome.state).toBe("failed");
    expect(outcome.completion.code).toBe("auth");
    expect(outcome.completion.reason).toBe("provider returned 401: Invalid API key.");
  });

  test("takes the code from the status the provider returned", () => {
    const of = (status: number) =>
      done(`${status} {"type":"error","error":{"message":"nope"}}`).completion.code;
    expect(of(402)).toBe("billing");
    expect(of(429)).toBe("rate_limit");
    expect(of(403)).toBe("auth");
    expect(of(500)).toBe("worker_error");
  });

  test("says the turn died instead of blaming the sign-off", () => {
    const outcome = interpretWorkerOutcome(0, "(no final message: …)", "", aborted);
    expect(outcome.state).toBe("failed");
    expect(outcome.completion.code).toBe("aborted");
    expect(outcome.completion.reason).toBe(aborted);
  });

  // The other half of the distinction: a worker that finished and did not sign
  // off is still unverified, and a worker writing prose about auth or rate
  // limits is not a provider rejection.
  test("leaves a finished-but-unsigned run unverified", () => {
    expect(done("I fixed the authentication bug; the rate limit handling is done.").completion.code)
      .toBe("unverified");
  });

  test("a signed-off run is completed even if the stream also carried a rejection", () => {
    expect(done(`${AUTH}\nRetried on the second key.\nINTER_RESULT: completed`).state).toBe("completed");
  });
});

describe("needs-input marker", () => {
  test("accepts a bolded question and strips the closing bold", () => {
    const output = "**INTER_NEEDS_INPUT: Which database should I target?**";
    expect(needsInputQuestion(output)).toBe("Which database should I target?");
    expect(done(output).state).toBe("needs_input");
  });

  test("accepts a bulleted question", () => {
    expect(done("- INTER_NEEDS_INPUT: Which one?").state).toBe("needs_input");
  });
});
