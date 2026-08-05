import { test } from "bun:test";
import { Database } from "bun:sqlite";
test("probe", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE task_events(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, event_type TEXT, state TEXT, payload TEXT)`);
  const t = "t1";
  for (let i = 0; i < 10; i++) db.query("INSERT INTO task_events(task_id, event_type, state, payload) VALUES (?,?,?,?)").run(t, "agent.event", "running", "{}");
  const rows = db.query<{ id: number }, [string, number]>(`
    SELECT id FROM task_events
    WHERE task_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(t, 4);
  console.log("desc limit 4:", rows.map((r) => r.id));
});
