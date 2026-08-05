/// Throwaway audit: runs the real normalizer over every stored event and reports
/// where it lands, per provider. Written for the activity-rendering review.
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { taskEventView } from "../src/events";

const db = new Database(`${process.env.HOME}/.inter/inter.db`, { readonly: true });
const OUT = `${import.meta.dir}/../.inter-analysis`;
mkdirSync(OUT, { recursive: true });

const rows = db.query(`
  SELECT e.id, e.task_id, e.event_type, e.state, e.payload, e.created_at, p.provider
  FROM task_events e JOIN tasks t ON t.id = e.task_id JOIN profiles p ON p.id = t.profile_id
  ORDER BY e.id
`).all() as any[];

type Bucket = { count: number; samples: any[] };
const byProvider: Record<string, Record<string, Bucket>> = {};

for (const row of rows) {
  let payload: any = {};
  try { payload = JSON.parse(row.payload); } catch {}
  const view = taskEventView(
    { id: row.id, taskId: row.task_id, type: row.event_type, state: row.state, payload, createdAt: row.created_at } as any,
    row.provider,
  );
  // How the row would read: kind, title, whether it says anything, and whether
  // the trace folds it away.
  const key = [
    view.kind,
    view.title,
    view.detail ? "detail" : "NO-DETAIL",
    view.presentation ? `pres:${view.presentation.type}` : "NO-PRES",
    view.minor ? "minor" : "shown",
  ].join(" | ");
  const provider = (byProvider[row.provider] ??= {});
  const bucket = (provider[key] ??= { count: 0, samples: [] });
  bucket.count++;
  if (bucket.samples.length < 2) {
    bucket.samples.push({
      eventType: row.event_type,
      view: { ...view, rawText: undefined },
      payload: JSON.stringify(payload).slice(0, 4000),
    });
  }
}

for (const [provider, buckets] of Object.entries(byProvider)) {
  const sorted = Object.entries(buckets).sort((a, b) => b[1].count - a[1].count);
  const lines = [`# ${provider} — ${rows.filter(r => r.provider === provider).length} stored events`, ""];
  lines.push("## How every event lands after normalization", "");
  lines.push("| n | kind | title | detail | presentation | trace |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const [key, bucket] of sorted) {
    lines.push(`| ${bucket.count} | ${key.split(" | ").join(" | ")} |`);
  }
  lines.push("", "## Samples (payload truncated to 4000 chars)", "");
  for (const [key, bucket] of sorted) {
    lines.push(`### ${key}  (${bucket.count})`, "", "```json", JSON.stringify(bucket.samples, null, 2), "```", "");
  }
  writeFileSync(`${OUT}/${provider}.md`, lines.join("\n"));
  console.log(provider, sorted.length, "distinct row shapes");
}
