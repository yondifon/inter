import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/store";
import { inFlightReport } from "../src/inflight";
import {
  captureWorkerIdentity,
  parseWorkerIdentity,
  probeWorker,
  signalWorkerGroup,
  type WorkerIdentity,
} from "../src/worker-identity";
import type { Profile, Task } from "../src/types";

const roots: string[] = [];
const strays: Array<{ kill: () => void }> = [];
afterEach(() => {
  for (const child of strays.splice(0)) {
    try { child.kill(); } catch {}
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const profile: Profile = {
  id: "claude-work",
  label: "Claude work",
  provider: "claude",
  model: "sonnet",
  enabled: true,
  env: {},
  capabilities: ["review"],
};

function paths() {
  const root = mkdtempSync(join(tmpdir(), "inter-worker-"));
  roots.push(root);
  return { root, db: join(root, "inter.db") };
}

function task(state: Task["state"] = "running"): Task {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    profileId: profile.id,
    model: "opus",
    prompt: "review",
    cwd: "/tmp/project",
    state,
    output: "",
    scope: { read: ["**"], write: ["**"] },
    allowQuestions: true,
    createdAt: now,
    updatedAt: now,
  };
}

/** A real detached process, spawned the way workers are: its own group leader. */
function spawnWorkerLike(seconds = 30) {
  const child = Bun.spawn(["sleep", String(seconds)], {
    detached: true,
    stdout: "ignore",
    stderr: "ignore",
  });
  strays.push(child);
  return child;
}

async function waitForExit(identity: WorkerIdentity, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probeWorker(identity).status === "gone") return true;
    await Bun.sleep(25);
  }
  return false;
}

describe("worker identity", () => {
  test("a live process is identified as alive, and a dead one as gone", async () => {
    const child = spawnWorkerLike();
    const identity = captureWorkerIdentity(child.pid);
    expect(identity).toBeDefined();
    expect(identity!.pid).toBe(child.pid);
    // Detached spawns lead their own group, which is what makes kill(-pgid) safe.
    expect(identity!.pgid).toBe(child.pid);
    expect(probeWorker(identity!).status).toBe("alive");

    child.kill("SIGKILL");
    expect(await waitForExit(identity!)).toBe(true);
    const gone = probeWorker(identity!);
    expect(gone.status).toBe("gone");
    expect(gone.status === "gone" && gone.reason).toBe("no-such-process");
  });

  test("a pid that is not our worker is never mistaken for live and never signalled", async () => {
    // A real, live process that Inter did not start. The recorded identity
    // carries its pid but a different start time — exactly the shape of a
    // recycled pid: the number came back around, the process behind it did not.
    const stranger = spawnWorkerLike();
    const real = captureWorkerIdentity(stranger.pid);
    expect(real).toBeDefined();
    const recycled: WorkerIdentity = { ...real!, startUsec: real!.startUsec ^ 0x5a5a };

    const liveness = probeWorker(recycled);
    expect(liveness.status).toBe("gone");
    expect(liveness.status === "gone" && liveness.reason).toBe("pid-reused");

    const signalled = signalWorkerGroup(recycled, "SIGKILL");
    expect(signalled.outcome).toBe("gone");
    expect(signalled.outcome === "gone" && signalled.reason).toBe("pid-reused");

    // The whole point: the stranger is still running.
    await Bun.sleep(150);
    expect(probeWorker(real!).status).toBe("alive");
    expect(stranger.killed).toBe(false);
  });

  test("refuses to signal a process that does not lead its own group", async () => {
    // Not detached, so it joins the test runner's process group. Signalling
    // that group would take down the test run and everything beside it.
    const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    strays.push(child);
    const identity = captureWorkerIdentity(child.pid);
    expect(identity).toBeDefined();
    expect(identity!.pgid).not.toBe(identity!.pid);

    const signalled = signalWorkerGroup(identity!, "SIGKILL");
    expect(signalled.outcome).toBe("refused");
    expect(signalled.outcome === "refused" && signalled.reason).toContain("not its own group leader");

    await Bun.sleep(150);
    expect(probeWorker(identity!).status).toBe("alive");
  });

  test("signals the group of a worker it positively identifies", async () => {
    const child = spawnWorkerLike();
    const identity = captureWorkerIdentity(child.pid)!;
    const signalled = signalWorkerGroup(identity, "SIGKILL");
    expect(signalled.outcome).toBe("signalled");
    expect(await waitForExit(identity)).toBe(true);
  });

  test("treats a nonsense pid as unknown and refuses to signal it", () => {
    // kill(0, sig) hits the caller's own process group and kill(-1, sig) hits
    // every process the user owns, so these must never reach process.kill.
    for (const pid of [0, -1, -4242, 1.5, Number.NaN]) {
      const identity: WorkerIdentity = {
        pid, pgid: pid, startSec: 1, startUsec: 1, comm: "sleep", capturedAt: "",
      };
      const liveness = probeWorker(identity);
      expect(liveness.status).toBe("unknown");
      expect(signalWorkerGroup(identity, "SIGKILL").outcome).toBe("refused");
    }
  });

  test("a garbled or absent identity record never yields a signal target", () => {
    expect(parseWorkerIdentity(undefined)).toBeUndefined();
    expect(parseWorkerIdentity(null)).toBeUndefined();
    expect(parseWorkerIdentity("not json")).toBeUndefined();
    expect(parseWorkerIdentity("{}")).toBeUndefined();
    expect(parseWorkerIdentity(JSON.stringify({ pid: 1 }))).toBeUndefined();
    expect(parseWorkerIdentity(JSON.stringify({ pid: "1", pgid: 1, startSec: 1, startUsec: 1 })))
      .toBeUndefined();
    const good = parseWorkerIdentity(JSON.stringify({ pid: 7, pgid: 7, startSec: 1, startUsec: 2 }));
    expect(good).toEqual({ pid: 7, pgid: 7, startSec: 1, startUsec: 2, comm: "", capturedAt: "" });
  });
});

describe("broker restart recovery", () => {
  test("fails a task whose worker is gone, wording unchanged", async () => {
    const { db } = paths();
    const first = new StateStore({ path: db, seedProfiles: [profile] });
    const work = task("running");
    first.createTask(work);
    const child = spawnWorkerLike();
    const identity = captureWorkerIdentity(child.pid)!;
    first.recordTaskWorker(work.id, identity);
    child.kill("SIGKILL");
    expect(await waitForExit(identity)).toBe(true);
    first.close();

    const restarted = new StateStore({ path: db, seedProfiles: [profile] });
    try {
      const recovered = restarted.getTask(work.id);
      expect(recovered?.state).toBe("failed");
      expect(recovered?.error).toBe("Broker restarted before task completed");
      const event = restarted.listTaskEvents(work.id).at(-1);
      expect(event?.type).toBe("broker_restarted");
      expect(event?.payload.worker).toBe("gone");
    } finally {
      restarted.close();
    }
  });

  test("reaps a worker that outlived the broker, and the record does not say failed", async () => {
    const { db } = paths();
    const first = new StateStore({ path: db, seedProfiles: [profile] });
    const work = task("running");
    first.createTask(work);
    const child = spawnWorkerLike();
    const identity = captureWorkerIdentity(child.pid)!;
    first.recordTaskWorker(work.id, identity);
    first.close();

    // The broker dies; the detached worker does not.
    expect(probeWorker(identity).status).toBe("alive");

    const restarted = new StateStore({ path: db, seedProfiles: [profile] });
    try {
      const recovered = restarted.getTask(work.id);
      expect(recovered?.state).toBe("cancelled");
      expect(recovered?.state).not.toBe("failed");
      expect(recovered?.error).toContain("outlived it and was stopped");
      expect(recovered?.completion?.code).toBe("cancelled");
      const event = restarted.listTaskEvents(work.id).at(-1);
      expect(event?.type).toBe("broker_restarted");
      expect(event?.payload.worker).toBe("reaped");

      // The process is actually dead, not merely relabelled.
      expect(await waitForExit(identity)).toBe(true);
      // And the stamp is cleared, so a third boot cannot re-probe the pid.
      expect(restarted.taskWorker(work.id)).toBeUndefined();
    } finally {
      restarted.close();
    }
  });

  test("records ambiguity instead of guessing when identity cannot be confirmed", async () => {
    const { db } = paths();
    const first = new StateStore({ path: db, seedProfiles: [profile] });
    const work = task("running");
    first.createTask(work);
    // A live process that is not ours and does not lead its own group: alive by
    // pid, unconfirmable as our worker, and unsafe to signal.
    const stranger = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    strays.push(stranger);
    const identity = captureWorkerIdentity(stranger.pid)!;
    first.recordTaskWorker(work.id, identity);
    first.close();

    const restarted = new StateStore({ path: db, seedProfiles: [profile] });
    try {
      const recovered = restarted.getTask(work.id);
      expect(recovered?.state).toBe("blocked");
      expect(recovered?.error).toContain("could not be confirmed as ours");
      const event = restarted.listTaskEvents(work.id).at(-1);
      expect(event?.payload.worker).toBe("unconfirmed");

      // Left strictly alone.
      await Bun.sleep(150);
      expect(probeWorker(identity).status).toBe("alive");
      expect(stranger.killed).toBe(false);
    } finally {
      restarted.close();
    }
  });

  test("a worker that exited normally leaves no stamp for the next boot", async () => {
    const { db } = paths();
    const first = new StateStore({ path: db, seedProfiles: [profile] });
    const work = task("running");
    first.createTask(work);
    const child = spawnWorkerLike();
    first.recordTaskWorker(work.id, captureWorkerIdentity(child.pid));
    expect(first.taskWorker(work.id)).toBeDefined();

    // What runTask's `finally` does when the child exits.
    first.recordTaskWorker(work.id, undefined);
    expect(first.taskWorker(work.id)).toBeUndefined();
    first.close();

    // The pid is still live, so a leftover stamp would have been read as a live
    // worker and reaped. Cleared, it falls to the plain failure path instead.
    const restarted = new StateStore({ path: db, seedProfiles: [profile] });
    try {
      const recovered = restarted.getTask(work.id);
      expect(recovered?.state).toBe("failed");
      expect(recovered?.error).toBe("Broker restarted before task completed");
      expect(restarted.listTaskEvents(work.id).at(-1)?.payload.worker).toBe("none");
      expect(child.killed).toBe(false);
    } finally {
      restarted.close();
    }
  });

  test("counts exactly the states recovery settles, so the warning cannot overstate", () => {
    const { db } = paths();
    const store = new StateStore({ path: db, seedProfiles: [profile] });
    try {
      const atRisk: Task[] = [task("queued"), task("running")];
      const untouched: Task[] = [
        task("needs_input"), task("answered"), task("blocked"),
        task("completed"), task("failed"), task("cancelled"),
      ];
      for (const t of [...atRisk, ...untouched]) store.createTask(t);
      expect(new Set(store.inFlightTasks().map(({ id }) => id)))
        .toEqual(new Set(atRisk.map(({ id }) => id)));
    } finally {
      store.close();
    }
  });

  test("observing the store neither recovers nor reaps", async () => {
    const { db } = paths();
    const first = new StateStore({ path: db, seedProfiles: [profile] });
    const work = task("running");
    first.createTask(work);
    const child = spawnWorkerLike();
    const identity = captureWorkerIdentity(child.pid)!;
    first.recordTaskWorker(work.id, identity);
    first.close();

    const observer = new StateStore({ path: db, observe: true });
    try {
      expect(observer.getTask(work.id)?.state).toBe("running");
      expect(observer.inFlightTasks()).toEqual([
        { id: work.id, state: "running", pid: child.pid },
      ]);
      await Bun.sleep(150);
      expect(probeWorker(identity).status).toBe("alive");
    } finally {
      observer.close();
    }
  });
});

describe("in-flight report", () => {
  test("says nothing is at risk when nothing is", () => {
    expect(inFlightReport([])).toBe("No tasks in flight.");
  });

  test("counts the tasks a restart would stop and names what happens to them", () => {
    const report = inFlightReport([
      { id: "task-a", state: "running", title: "port the schema engine", pid: 4242 },
      { id: "task-b", state: "queued" },
    ]);
    expect(report).toContain("2 tasks in flight");
    expect(report).toContain("task-a  running  pid 4242  port the schema engine");
    expect(report).toContain("task-b  queued  no worker");
    expect(report).toContain("resume");
  });

  test("agrees in number with the singular", () => {
    expect(inFlightReport([{ id: "solo", state: "running", pid: 1 }])).toContain("1 task in flight");
  });
});
