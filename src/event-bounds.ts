/**
 * `taskEventView` (events.ts) classifies a row from a fixed set of short,
 * structural fields — hook_event_name, tool_name, tool_input, tool_use_id,
 * duration_ms, error, and their per-provider equivalents — never more than a
 * couple hundred bytes of any single free-text value. This module never
 * removes or renames a key; it only shortens string leaves once the whole
 * payload runs over budget, so a classifier reading any structural or
 * already-short field sees it unchanged.
 *
 * agent.hook, agent.user and agent.tool_use average several KB with outliers
 * up to 105 KB, all of it free text (tool output, message bodies) the
 * classifier never reads past its own ~500-character preview. 8 KB keeps
 * 15-30x that preview's needs for debugging headroom while cutting the
 * measured outliers by 85-95%, and leaves ordinary small events untouched.
 */
export const MAX_EVENT_PAYLOAD_BYTES = 8 * 1024;

const MIN_TRUNCATABLE_BYTES = 256;
const MARKER_RESERVE_BYTES = 80;

type PathSegment = string | number;

interface StringLeaf {
  path: PathSegment[];
  bytes: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateToBytes(value: string, maxBytes: number): string {
  return Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
}

function truncationMarker(keptBytes: number, originalBytes: number): string {
  return ` …[truncated: kept ${keptBytes} of ${originalBytes} bytes]`;
}

function collectStringLeaves(value: unknown, path: PathSegment[], out: StringLeaf[]): void {
  if (typeof value === "string") {
    out.push({ path, bytes: byteLength(value) });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectStringLeaves(item, [...path, index], out));
  } else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) collectStringLeaves(item, [...path, key], out);
  }
}

function readAt(root: Record<string, unknown>, path: PathSegment[]): unknown {
  let node: unknown = root;
  for (const segment of path) {
    node = isPlainObject(node) ? node[segment as string]
      : Array.isArray(node) ? node[segment as number]
      : undefined;
  }
  return node;
}

function writeAt(root: Record<string, unknown>, path: PathSegment[], value: unknown): void {
  let node: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < path.length - 1; i++) node = (node as Record<string, unknown>)[path[i] as string] as typeof node;
  (node as Record<string, unknown>)[path[path.length - 1] as string] = value;
}

/**
 * Bounds one event payload to MAX_EVENT_PAYLOAD_BYTES. Untouched, same
 * reference, when already within budget. Over budget, shrinks the largest
 * string leaves first — the file content, stdout, or message body that
 * accounts for the overrun — leaving every key and every short value in
 * place, and appends an inline marker to each shortened value stating how
 * much was kept and how much the field held originally.
 */
export function boundEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const size = byteLength(JSON.stringify(payload));
  if (size <= MAX_EVENT_PAYLOAD_BYTES) return payload;

  const clone = structuredClone(payload) as Record<string, unknown>;
  const leaves: StringLeaf[] = [];
  collectStringLeaves(clone, [], leaves);
  leaves.sort((a, b) => b.bytes - a.bytes);

  let remaining = size;
  for (const leaf of leaves) {
    if (remaining <= MAX_EVENT_PAYLOAD_BYTES) break;
    if (leaf.bytes < MIN_TRUNCATABLE_BYTES) continue;
    const value = readAt(clone, leaf.path);
    if (typeof value !== "string") continue;
    const overshoot = remaining - MAX_EVENT_PAYLOAD_BYTES;
    const keepBytes = leaf.bytes - overshoot - MARKER_RESERVE_BYTES;
    if (keepBytes >= leaf.bytes || keepBytes < MIN_TRUNCATABLE_BYTES / 2) continue;
    const kept = truncateToBytes(value, keepBytes);
    const truncated = kept + truncationMarker(byteLength(kept), leaf.bytes);
    writeAt(clone, leaf.path, truncated);
    remaining = remaining - leaf.bytes + byteLength(truncated);
  }
  return clone;
}
