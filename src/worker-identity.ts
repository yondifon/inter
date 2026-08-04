import { dlopen, ptr, suffix } from "bun:ffi";

/**
 * Who a task's worker process is, durably enough to survive a broker restart.
 *
 * A bare pid is not an identity: the OS recycles pids, so a restarted broker
 * that trusted one could signal an unrelated process of the user's. The key
 * here is the kernel's own process start time (`p_starttime`, microseconds),
 * which is stamped at fork and is immutable for the life of the process. Two
 * processes can share a pid across time but not a pid *and* the microsecond
 * they started, so `pid + startSec + startUsec` names exactly one process.
 *
 * `comm` is recorded for humans reading the row, never for matching: workers
 * are spawned as `sandbox-exec`, which then `execve`s the real provider CLI in
 * the same process. Verified: `exec` leaves the start time bit-identical while
 * `comm` changes underneath it, so gating on `comm` would misread every live
 * worker as recycled.
 *
 * `pgid` is what cancellation signals (`kill(-pgid)`). A detached spawn makes
 * the child the leader of its own group, so a genuine worker always reports
 * `pgid === pid`; anything else means the group is not ours to signal.
 */
export interface WorkerIdentity {
  pid: number;
  pgid: number;
  /** Kernel process start time, seconds since epoch. */
  startSec: number;
  /** Kernel process start time, microsecond remainder. The anti-reuse key. */
  startUsec: number;
  /** Executable name when captured. Diagnostic only — `exec` rewrites it. */
  comm: string;
  /** Broker clock at capture, so a stale row is legible without the kernel. */
  capturedAt: string;
}

export type WorkerLiveness =
  /** This exact process is still running. */
  | { status: "alive"; comm: string }
  /** Positively established that our worker is not running. Safe to fail. */
  | { status: "gone"; reason: "no-such-process" | "pid-reused" }
  /** Liveness could not be established. Never signal, never assume either way. */
  | { status: "unknown"; reason: string };

/**
 * `struct kinfo_proc` field offsets, x86_64 and arm64 alike. Both are part of
 * the stable `<sys/sysctl.h>` ABI that `ps` itself reads, but the parse is
 * still checked against a known-good field (`p_pid`) before anything trusts
 * it — see `readProcess`. A layout change therefore degrades to "unknown",
 * which is inert, rather than to a confident wrong answer.
 */
const OFFSET_START_SEC = 0;
const OFFSET_START_USEC = 8;
const OFFSET_PID = 40;
const OFFSET_COMM = 243;
const COMM_LENGTH = 17;
const OFFSET_PGID = 564;
const KINFO_PROC_SIZE = 648;

const CTL_KERN = 1;
const KERN_PROC = 14;
const KERN_PROC_PID = 1;

type Sysctl = (
  name: unknown, namelen: number, oldp: unknown, oldlenp: unknown, newp: null, newlen: number,
) => number;

let sysctlHandle: Sysctl | null | undefined;

// dlopen once, and remember failure as well as success: a broker that cannot
// reach libc must not pay for the attempt on every task it recovers.
function sysctl(): Sysctl | null {
  if (sysctlHandle !== undefined) return sysctlHandle;
  if (process.platform !== "darwin") return sysctlHandle = null;
  try {
    const lib = dlopen(`libc.${suffix}`, {
      sysctl: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "usize"], returns: "i32" },
    });
    return sysctlHandle = lib.symbols.sysctl as unknown as Sysctl;
  } catch {
    return sysctlHandle = null;
  }
}

interface ProcessFacts {
  pid: number;
  pgid: number;
  startSec: number;
  startUsec: number;
  comm: string;
}

type ProcessRead =
  | { ok: true; facts: ProcessFacts }
  | { ok: false; reason: "no-such-process" }
  | { ok: false; reason: "unreadable"; detail: string };

/**
 * Ask the kernel about one pid. This is a syscall rather than a shell out to
 * `ps` deliberately: `/bin/ps` is setuid root and is refused outright inside
 * sandboxes, `lstart` resolves only to the second (far too coarse to separate
 * a recycled pid from its predecessor), and its output is locale-dependent
 * text. `sysctl` needs no privileges to read a process the caller owns.
 */
function readProcess(pid: number): ProcessRead {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: "unreadable", detail: `not a pid: ${pid}` };
  }
  const call = sysctl();
  if (!call) return { ok: false, reason: "unreadable", detail: "kernel process table unavailable" };
  const mib = new Int32Array([CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]);
  const buffer = new Uint8Array(KINFO_PROC_SIZE * 2);
  const length = new BigUint64Array([BigInt(buffer.length)]);
  let rc: number;
  try {
    rc = call(ptr(mib), 4, ptr(buffer), ptr(length), null, 0);
  } catch (error) {
    return { ok: false, reason: "unreadable", detail: String(error) };
  }
  if (rc !== 0) return { ok: false, reason: "unreadable", detail: `sysctl returned ${rc}` };
  // The kernel reports a dead pid as a successful call with nothing to say.
  if (length[0] === 0n) return { ok: false, reason: "no-such-process" };
  if (length[0] < BigInt(KINFO_PROC_SIZE)) {
    return { ok: false, reason: "unreadable", detail: `short record: ${length[0]} bytes` };
  }
  const view = new DataView(buffer.buffer);
  const reported = view.getInt32(OFFSET_PID, true);
  // The parse checked against itself. If the record we decoded does not name
  // the pid we asked about, the layout is not what this code believes it is,
  // and every other field read from it is noise.
  if (reported !== pid) {
    return { ok: false, reason: "unreadable", detail: `record names pid ${reported}, asked for ${pid}` };
  }
  return {
    ok: true,
    facts: {
      pid,
      pgid: view.getInt32(OFFSET_PGID, true),
      startSec: Number(view.getBigInt64(OFFSET_START_SEC, true)),
      startUsec: view.getInt32(OFFSET_START_USEC, true),
      comm: new TextDecoder().decode(
        buffer.subarray(OFFSET_COMM, OFFSET_COMM + COMM_LENGTH),
      ).replace(/\0.*$/s, ""),
    },
  };
}

/**
 * Stamp a freshly spawned worker. Returns undefined when the kernel cannot be
 * read or the child died before we looked: recording nothing is correct there,
 * because an unverifiable identity is worse than no identity at all — the
 * recovery path treats a missing record as "no live worker" and never signals.
 */
export function captureWorkerIdentity(pid: number): WorkerIdentity | undefined {
  const read = readProcess(pid);
  if (!read.ok) return undefined;
  return { ...read.facts, capturedAt: new Date().toISOString() };
}

/** Is the process named by this identity the one still running? */
export function probeWorker(identity: WorkerIdentity): WorkerLiveness {
  const read = readProcess(identity.pid);
  if (!read.ok) {
    return read.reason === "no-such-process"
      ? { status: "gone", reason: "no-such-process" }
      : { status: "unknown", reason: read.detail };
  }
  const { facts } = read;
  // Same number, different process. That the pid was handed out again is itself
  // proof our worker exited, so this is a definite answer, not an ambiguous one
  // — and the pid now belongs to someone else, so it must never be signalled.
  if (facts.startSec !== identity.startSec || facts.startUsec !== identity.startUsec) {
    return { status: "gone", reason: "pid-reused" };
  }
  return { status: "alive", comm: facts.comm };
}

export type SignalOutcome =
  | { outcome: "signalled"; pgid: number }
  | { outcome: "gone"; reason: string }
  | { outcome: "refused"; reason: string };

/**
 * Signal a worker's process group, but only after re-confirming, against the
 * kernel and at this instant, that the group is ours.
 *
 * Every refusal below is the same defect: signalling a pid we have not
 * positively identified. `kill(-pgid)` hits every process in a group, so a
 * wrong answer here does not cost one stray process, it costs a whole session
 * of the user's. The checks are ordered cheapest-doubt-first and any doubt at
 * all declines to signal.
 */
export function signalWorkerGroup(identity: WorkerIdentity, signal: NodeJS.Signals): SignalOutcome {
  const liveness = probeWorker(identity);
  if (liveness.status === "gone") return { outcome: "gone", reason: liveness.reason };
  if (liveness.status === "unknown") return { outcome: "refused", reason: liveness.reason };
  // A detached spawn leaves the child leading its own group, so this holds for
  // every worker Inter starts. If it does not hold, the recorded pgid names a
  // group built by someone else and `kill(-pgid)` would reach into it.
  if (identity.pgid !== identity.pid) {
    return { outcome: "refused", reason: `worker is not its own group leader (pgid ${identity.pgid})` };
  }
  const current = readProcess(identity.pid);
  if (!current.ok) return { outcome: "refused", reason: "process became unreadable mid-check" };
  // Re-read rather than trust the stamp: a process can be moved between groups
  // after we recorded it, and the group we signal must be the one it is in now.
  if (current.facts.pgid !== identity.pgid) {
    return { outcome: "refused", reason: `process group changed to ${current.facts.pgid}` };
  }
  try {
    process.kill(-identity.pgid, signal);
    return { outcome: "signalled", pgid: identity.pgid };
  } catch (error) {
    // ESRCH here means it exited in the microseconds since the probe, which is
    // the outcome we wanted anyway.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { outcome: "gone", reason: "exited during signal" };
    return { outcome: "refused", reason: String(error) };
  }
}

export function parseWorkerIdentity(json: string | null | undefined): WorkerIdentity | undefined {
  if (!json) return undefined;
  try {
    const value = JSON.parse(json) as Partial<WorkerIdentity>;
    if (
      !value || typeof value !== "object" ||
      typeof value.pid !== "number" || typeof value.pgid !== "number" ||
      typeof value.startSec !== "number" || typeof value.startUsec !== "number"
    ) return undefined;
    return {
      pid: value.pid,
      pgid: value.pgid,
      startSec: value.startSec,
      startUsec: value.startUsec,
      comm: typeof value.comm === "string" ? value.comm : "",
      capturedAt: typeof value.capturedAt === "string" ? value.capturedAt : "",
    };
  } catch {
    return undefined;
  }
}
