#!/usr/bin/env bun
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";
import { loadConfig, saveConfig } from "./config";
import {
  appendTaskEvent,
  assertTaskCompletion,
  cancelTask,
  delegate,
  getTask,
  handoffTask,
  listTasks,
  listTaskSummaries,
  reply,
  resumeTask,
  scopeInheritanceWarning,
  setTaskArchived,
  unknownTaskMessage,
  waitForTasks,
} from "./tasks";
import { listModels } from "./models";
import { routeModel } from "./model-router";
import { listProfileStatuses } from "./profile-status";
import { listProfileUsage } from "./usage";
import { stateStore } from "./store";
import type { Profile, Provider, Task } from "./types";
import { taskEventView } from "./events";
import { COMPLETE_DESCRIPTION, DELEGATE_DESCRIPTION, HANDOFF_DESCRIPTION, MCP_INSTRUCTIONS } from "./mcp-copy";
import { defaultModelFor } from "./provider-defaults";
import { normalizeProfile } from "./profile-input";
import { deleteMemory, getMemory, listMemories, setMemory } from "./memories";
import { publicTaskSummary, taskView, waitEventsView, waitTaskView, settled, TASK_FIELD_KEYS, type TaskField } from "./public-task";
import { mcpWaitBlockMs } from "./mcp-wait";
import { loadRoutingPolicy } from "./routing-policy";
import { runWatch, watchCommand } from "./watch";
import { runInflight } from "./inflight";
import { startEventSocket } from "./event-socket";
import { BUILD_STAMP, MCP_CONTRACT_VERSION, VERSION } from "./version";

const port = Number(Bun.env.INTER_PORT ?? 7331);
// The one answer to "what build are you": /health serves it from the broker on
// the port, `version` prints it from the binary on disk, and `make install`
// fails when those two disagree. One literal, so the two cannot drift.
const healthReport = { status: "ok", version: VERSION, mcpContractVersion: MCP_CONTRACT_VERSION, build: BUILD_STAMP } as const;

// `watch` is the one invocation that is not the broker. It reads the same
// SQLite store the broker writes, rather than calling the broker over HTTP, so
// a caller holding a task id gets an answer even when nothing is listening on
// the port — and the deadline belongs to the process, not to a request. It must
// therefore claim the process before Bun.serve binds anything.
if (process.argv[2] === "watch") {
  process.exit(await runWatch(process.argv.slice(3)));
}

// `inflight` reports what a broker restart would cost, so it must not be one:
// it reads the store as an observer and exits non-zero when work is at risk,
// which is what lets `make install` warn before it kills anything.
if (process.argv[2] === "inflight") {
  process.exit(runInflight());
}

// `version` is the binary's own answer to /health, read from disk rather than
// from the port — the comparison `make install` makes before it calls an
// install done. It claims the process before Bun.serve binds for the same
// reason `watch` does.
if (process.argv[2] === "version") {
  console.log(JSON.stringify(healthReport));
  process.exit(0);
}

// Anything else in argv[2] is a typo reaching for a subcommand, and booting
// the broker anyway dies on the bound port with an EADDRINUSE that says
// nothing about the mistake. `--stdio` is a flag for MCP client configs, not
// a subcommand, and no argument at all is the app bundle launching the broker.
if (process.argv[2] !== undefined && process.argv[2] !== "--stdio") {
  console.error(`unknown command '${process.argv[2]}' — usage: inter [watch <taskId...> | inflight | version]`);
  process.exit(2);
}

// A foreground MCP call still owns the caller's agent turn, which is why
// `until: "attention"` matters: it returns the instant the task needs the
// caller rather than burning the full block. `inter watch` is the way out of
// that trade entirely — a backgrounded process owns no turn at all.
const scopeSchema = z.object({
  read: z.array(z.string()).max(200),
  write: z.array(z.string()).max(200),
});
const taskStateSchema = z.enum([
  "queued", "running", "needs_input", "answered", "blocked", "completed", "failed", "cancelled",
]);

const taskFieldSchema = z.array(z.enum(TASK_FIELD_KEYS)).optional()
  .describe(
    "The response shape. Defaults to a small acknowledgement; supplying any `fields` replaces " +
    "the default, it does not add to it. `[\"all\"]` returns the full record. " +
    "Heavy groups that cost real context: `prompt`, `shippedPrompt`, `output`, `attempts`.",
  );

// The delegate contract, described once. The MCP tool and the REST dispatch
// body are the same inputs; one schema is what keeps the two surfaces from
// drifting apart again.
const delegateToolSchema = z.object({
  profile: z.string().optional()
    .describe("Profile id to run on. Omit for automatic routing; see profiles."),
  model: z.string().min(1).max(200).optional()
    .describe("Model id for that profile. Omit to use the profile's default."),
  preference: z.enum(["balanced", "quality", "cost", "speed"]).optional()
    .describe("Bias for automatic routing. Ignored when profile is set."),
  prompt: z.string().min(1).max(64_000)
    .describe("Structured markdown: Goal, Context, Scope, numbered Instructions, Guardrails, Output Format."),
  cwd: z.string().min(1)
    .describe("Absolute path the worker runs in. Scope and grants are keyed to it."),
  parent: z.string().optional()
    .describe("Task id of the first task in a fan-out, so the batch groups together."),
  scope: scopeSchema.optional()
    .describe(
      "Paths the worker may touch, relative to cwd: literal file paths, dir/** for recursive, ** for the whole tree. " +
      "Stating it records a grant on this cwd; omitting it reuses the newest grant, or falls back to ** and flags the task when none exists.",
    ),
  allowQuestions: z.boolean().default(true)
    .describe("Whether the worker may pause in needs_input to ask. False makes it guess or stop."),
  effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional()
    .describe(
      "Reasoning effort for this run. Honoured by claude, codex, opencode, and pi; antigravity " +
      "ignores it because its level is baked into the model id. Ladders differ per provider, " +
      "so call profiles with include: [\"models\"] and read the model's efforts before choosing.",
    ),
  tldr: z.string().min(1).max(200).optional()
    .describe(
      "One plain sentence, in the user's terms, saying what the task will do and to what; the " +
      "user reads it on the task list, not the prompt. No markdown, no file paths unless they " +
      "are the point.",
    ),
  title: z.string().min(1).max(60)
    .describe(
      "Short imperative label, max 60 chars, what the task does, no markdown, " +
      "readable at a glance in a sidebar.",
    ),
  timeoutMs: z.number().int().min(1).max(86_400_000).optional()
    .describe("Hard runtime limit. The task lands in failed with code timeout."),
  fields: taskFieldSchema,
});

// The REST body is the tool contract minus the MCP-only knobs. Two deliberate
// differences: REST never auto-routed, so profile is required even though the
// tool treats it as an optional hint, and the GUI is not the one writing
// prompts, so title stays optional even though the tool requires it.
const delegateBodySchema = delegateToolSchema
  .omit({ preference: true, effort: true, fields: true })
  .extend({
    profile: z.string().min(1),
    title: z.string().min(1).max(60).optional(),
  });

const profilePatchSchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().min(1).optional(),
  provider: z.enum(["claude", "codex", "opencode", "antigravity", "pi"]).optional(),
  model: z.string().min(1).max(200).optional(),
  capabilities: z.array(z.string()).optional(),
  // The app round-trips the masked values, and the masked sentinel must survive.
  env: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

const archiveBodySchema = z.object({ archived: z.boolean() });

const DEFAULT_DELEGATE_FIELDS: TaskField[] = ["routing"];
const DEFAULT_REPLY_FIELDS: TaskField[] = [];
const DEFAULT_RESUME_FIELDS: TaskField[] = [];
// Where the task landed is the one thing a handoff changed and the caller does
// not already know, so routing rides the acknowledgement.
const DEFAULT_HANDOFF_FIELDS: TaskField[] = ["routing"];
const DEFAULT_CANCEL_FIELDS: TaskField[] = [];
const DEFAULT_COMPLETE_FIELDS: TaskField[] = [];
const DEFAULT_ARCHIVE_FIELDS: TaskField[] = [];
const DEFAULT_INSPECT_FIELDS: TaskField[] = (() => {
  const excluded = new Set(["prompt", "shippedPrompt", "attempts", "all"]);
  return TASK_FIELD_KEYS.filter((k): k is TaskField => !excluded.has(k));
})();

// Preferred revision is 2026-07-28: stateless, no session pinning, one fresh
// server per request so dynamic profile tools always reflect current settings.
// `legacy: "stateless"` serves 2025-era clients off the same factory — today's
// CLIs (Claude Code, codex, gemini) top out at 2025-11-25, so modern-only
// would mean no client can connect.
const mcpHandler = createMcpHandler(() => createMcpServer(), {
  legacy: "stateless",
  onerror: (error) => console.error("mcp request failed", error),
});

Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return mcpHandler.fetch(request);
    if (url.pathname === "/health") {
      return Response.json(healthReport);
    }
    if (url.pathname === "/api/state" && request.method === "GET") {
      const config = await loadConfig();
      const summary = url.searchParams.get("view") === "summary";
      return Response.json({
        profiles: publicProfiles(config.profiles),
        // Output is already the parsed answer — finalText runs once, when the
        // run is persisted — so re-deriving it here would only make this poll
        // disagree with inspect and wait, on the hottest route in the broker.
        // The app polls this route every two seconds; `view=summary` swaps the
        // full rows (prompt + output per task) for the list rows, and the app
        // fetches one task in full only when it is opened.
        tasks: summary
          ? listTaskSummaries({ archived: archiveFilter(url.searchParams.get("archived")) }).map(publicTaskSummary)
          : listTasks(archiveFilter(url.searchParams.get("archived"))),
        // Why a provider is being avoided, and what each cwd is allowed to
        // touch — both cheap reads, both previously invisible in the app.
        profileFailures: stateStore().listProfileFailures(),
        grants: stateStore().listScopeGrants(),
        // One grouped count per cwd, cheap enough to ride the poll; the values
        // behind it are read only when a project is opened.
        memoryProjects: stateStore().listMemoryProjects(),
      });
    }
    // One project's memories, on demand: a value runs to 16k characters, far
    // too much to repeat on the two-second state poll.
    if (url.pathname === "/api/memories" && request.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return Response.json({ error: "cwd is required" }, { status: 400 });
      try {
        return Response.json({ memories: listMemories(cwd) });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    }
    // Quota lives on its own route: it shells out to provider CLIs and must not
    // slow the state poll that drives the whole UI.
    if (url.pathname === "/api/usage" && request.method === "GET") {
      const provider = url.searchParams.get("provider") as Provider | null;
      const profile = url.searchParams.get("profile") ?? undefined;
      const refresh = url.searchParams.get("refresh") === "true";
      try {
        return Response.json(await listProfileUsage({ ...(provider ? { provider } : {}), profile, refresh }));
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    }
    const grantId = url.pathname.match(/^\/api\/grants\/([^/]+)$/)?.[1];
    if (grantId && request.method === "DELETE") {
      const revoked = stateStore().revokeScopeGrant(decodeURIComponent(grantId));
      if (!revoked) return Response.json({ error: "unknown grant" }, { status: 404 });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/api/models" && request.method === "GET") {
      const provider = url.searchParams.get("provider") as Provider | null;
      const profile = url.searchParams.get("profile") ?? undefined;
      const refresh = url.searchParams.get("refresh") === "true";
      try {
        return Response.json(await listModels({ ...(provider ? { provider } : {}), profile, refresh }));
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    }
    const eventTaskId = url.pathname.match(/^\/api\/tasks\/([^/]+)\/events$/)?.[1];
    if (eventTaskId && request.method === "GET") {
      const taskId = decodeURIComponent(eventTaskId);
      const task = getTask(taskId);
      if (!task) return Response.json({ error: "unknown task" }, { status: 404 });
      const profile = (await loadConfig()).profiles.find(({ id }) => id === task.profileId);
      if (!profile) return Response.json({ error: "unknown task profile" }, { status: 404 });
      const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
      const waitMs = Math.min(30_000, Math.max(0, Number(url.searchParams.get("waitMs") ?? 0) || 0));
      // A tail read asks for what is already there, so it never blocks: `waitMs`
      // is ignored whenever `last` or `before` is present.
      const tailMode = url.searchParams.has("last") || url.searchParams.has("before");
      if (!tailMode && after > 0 && waitMs > 0 && stateStore().latestTaskEventId([taskId]) <= after && !settled(task.state)) {
        await waitForTasks([taskId], waitMs, request.signal, after);
      }
      if (tailMode) {
        // The newest `last` events, ascending; `before` moves the window back
        // for "load earlier" pages. `oldestId`/`hasEarlier` tell the app when
        // to stop paging back; `cursor` hands the follow loop its starting id.
        const last = Math.min(5_000, Math.max(1, Number(url.searchParams.get("last") ?? 5_000) || 0));
        const before = Math.max(0, Number(url.searchParams.get("before") ?? 0) || 0);
        const { events, hasEarlier } = stateStore().listTaskEventsTail(taskId, before || undefined, last);
        return Response.json({
          events: events.map((event) => taskEventView(event, profile.provider)),
          cursor: events.at(-1)?.id ?? after,
          hasMore: false,
          oldestId: events[0]?.id ?? 0,
          hasEarlier,
        });
      }
      const rows = stateStore().listTaskEvents(taskId, after);
      if (!url.searchParams.has("after") && !url.searchParams.has("waitMs")) {
        return Response.json(rows.map((event) => taskEventView(event, profile.provider)));
      }
      const hasMore = rows.length > 5_000;
      const events = rows.slice(0, 5_000);
      return Response.json({
        events: events.map((event) => taskEventView(event, profile.provider)),
        cursor: events.at(-1)?.id ?? after,
        hasMore,
      });
    }
    // One task in full, on demand: the detail view opens with this and refetches
    // when the summary row moves. The regex cannot shadow the /events or
    // /resume subroutes — a slash after the id matches neither — and POST
    // /api/tasks is a different method on a different path.
    const singleTaskId = url.pathname.match(/^\/api\/tasks\/([^/]+)$/)?.[1];
    if (singleTaskId && request.method === "GET") {
      const task = getTask(decodeURIComponent(singleTaskId));
      if (!task) return Response.json({ error: "unknown task" }, { status: 404 });
      return Response.json(task);
    }
    const hookTaskId = url.pathname.match(/^\/api\/hooks\/([^/]+)$/)?.[1];
    if (hookTaskId && request.method === "POST") {
      const task = getTask(decodeURIComponent(hookTaskId));
      if (!task) return Response.json({ error: "unknown task" }, { status: 404 });
      const payload = await readJson(request);
      if (payload === undefined) return invalidJsonBody();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return Response.json({ error: "hook payload must be an object" }, { status: 400 });
      }
      appendTaskEvent(task.id, "agent.hook", task.state, payload as Record<string, unknown>);
      return Response.json({});
    }
    if (url.pathname === "/api/profiles" && request.method === "POST") {
      const body = await readJson(request);
      if (body === undefined) return invalidJsonBody();
      try {
        const config = await loadConfig();
        const profile = normalizeProfile(body);
        if (config.profiles.some((item) => item.id === profile.id)) {
          profile.id = `${profile.id}-${crypto.randomUUID().slice(0, 6)}`;
        }
        config.profiles.push(profile);
        await saveConfig(config);
        return Response.json(publicProfile(profile), { status: 201 });
      } catch (error) {
        // normalizeProfile's messages ("invalid provider", "label is required")
        // are written for the user; a 500 would hide them behind the app's
        // generic save failure.
        return Response.json({ error: String(error) }, { status: 400 });
      }
    }
    if (url.pathname.startsWith("/api/profiles/") && request.method === "PUT") {
      const config = await loadConfig();
      const id = decodeURIComponent(url.pathname.slice("/api/profiles/".length));
      const profile = config.profiles.find((item) => item.id === id);
      if (!profile) return Response.json({ error: "unknown profile" }, { status: 404 });
      const body = await readJson(request);
      if (body === undefined) return invalidJsonBody();
      const parsed = profilePatchSchema.safeParse(body);
      if (!parsed.success) return Response.json({ error: describeZodIssue(parsed.error) }, { status: 400 });
      const patch = parsed.data;
      if (typeof patch.enabled === "boolean") profile.enabled = patch.enabled;
      if (patch.label?.trim()) profile.label = patch.label.trim();
      // The schema already narrowed provider to the five known ids.
      if (patch.provider) profile.provider = patch.provider;
      // A blank model means "back to this provider's default".
      if (patch.model !== undefined) {
        profile.model = patch.model.trim() || defaultModelFor(profile.provider);
      }
      if (patch.capabilities) profile.capabilities = patch.capabilities;
      if (patch.env) {
        profile.env = Object.fromEntries(Object.entries(patch.env).map(([key, value]) => [
          key,
          value === "••••••••" ? profile.env[key] ?? "" : String(value),
        ]));
      }
      await saveConfig(config);
      return Response.json(publicProfile(profile));
    }
    if (url.pathname.startsWith("/api/profiles/") && request.method === "DELETE") {
      const config = await loadConfig();
      const id = decodeURIComponent(url.pathname.slice("/api/profiles/".length));
      const index = config.profiles.findIndex((item) => item.id === id);
      if (index < 0) return Response.json({ error: "unknown profile" }, { status: 404 });
      config.profiles.splice(index, 1);
      await saveConfig(config);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/api/tasks" && request.method === "POST") {
      const body = await readJson(request);
      if (body === undefined) return invalidJsonBody();
      const parsed = delegateBodySchema.safeParse(body);
      if (!parsed.success) return Response.json({ error: describeZodIssue(parsed.error) }, { status: 400 });
      const { profile, prompt, cwd, model, parent, scope, allowQuestions, timeoutMs, tldr, title } = parsed.data;
      try {
        const task = await delegate(profile, prompt, cwd, model, parent, {
          scope,
          allowQuestions,
          timeoutMs,
          tldr,
          title,
        });
        return Response.json(
          startedTask(task, DEFAULT_DELEGATE_FIELDS),
          { status: 202 },
        );
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    }
    const patchTaskId = url.pathname.match(/^\/api\/tasks\/([^/]+)$/)?.[1];
    if (patchTaskId && request.method === "PATCH") {
      const body = await readJson(request);
      if (body === undefined) return invalidJsonBody();
      const parsed = archiveBodySchema.safeParse(body);
      if (!parsed.success) return Response.json({ error: describeZodIssue(parsed.error) }, { status: 400 });
      try {
        return Response.json(taskView(setTaskArchived(decodeURIComponent(patchTaskId), parsed.data.archived), DEFAULT_ARCHIVE_FIELDS));
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    }
    const cancelTaskId = url.pathname.match(/^\/api\/tasks\/([^/]+)$/)?.[1];
    if (cancelTaskId && request.method === "DELETE") {
      try {
        return Response.json(taskView(await cancelTask(
          decodeURIComponent(cancelTaskId),
          url.searchParams.get("reason") ?? undefined,
        ), DEFAULT_CANCEL_FIELDS));
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    }
    const resumeTaskId = url.pathname.match(/^\/api\/tasks\/([^/]+)\/resume$/)?.[1];
    if (resumeTaskId && request.method === "POST") {
      const text = await request.text();
      let body: {
        instruction?: string;
        timeoutMs?: number;
        scope?: { read: string[]; write: string[] };
        allowQuestions?: boolean;
      } = {};
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          return invalidJsonBody();
        }
      }
      try {
        return Response.json(
          startedTask(await resumeTask(decodeURIComponent(resumeTaskId), body.instruction, {
            timeoutMs: body.timeoutMs,
            scope: body.scope,
            allowQuestions: body.allowQuestions,
          }), DEFAULT_RESUME_FIELDS),
          { status: 202 },
        );
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    }
    return new Response("Not found", { status: 404 });
  },
});

// The port bind is the single-instance lock; the socket unlink after it can
// never steal a live broker's socket (D-007). The socket is an accelerator —
// watch falls back to DB polling when it is absent.
const eventSocket = startEventSocket({
  hello: { version: VERSION, mcpContractVersion: MCP_CONTRACT_VERSION },
});
if (eventSocket.path) {
  console.log(`event socket bound: ${eventSocket.path}`);
}

if (process.argv.includes("--stdio")) {
  serveStdio(() => createMcpServer());
}

async function createMcpServer(): Promise<McpServer> {
  const server = new McpServer(
    { name: "inter", version: VERSION },
    {
      instructions: MCP_INSTRUCTIONS,
    },
  );
  server.registerTool("delegate", {
    description: DELEGATE_DESCRIPTION,
    inputSchema: delegateToolSchema,
  }, async ({ profile, model, preference, prompt, cwd, parent, scope, allowQuestions, effort, tldr, title, timeoutMs, fields }) => {
    const resolvedFields = fields ?? DEFAULT_DELEGATE_FIELDS;
    if (profile) {
      // The caller named the account but not the model. Let the project policy
      // pick that profile's best model for this task class instead of falling
      // back to its single static default, which ignores difficulty entirely.
      const chosen = model ?? await routeModel(prompt, { preference, cwd, profileId: profile })
        .then((route) => route.model)
        .catch(() => undefined);
      const task = await delegate(profile, prompt, cwd, chosen, parent, { scope, allowQuestions, effort, tldr, title, timeoutMs });
      return result({ ...startedTask(task, resolvedFields), ...(await warningsFor(cwd, task)) });
    }
    const selection = await routeModel(prompt, { preference, modelHint: model, cwd });
    const task = await delegate(selection.profileId, prompt, cwd, selection.model, parent, {
      scope,
      allowQuestions,
      effort,
      tldr,
      title,
      timeoutMs,
    });
    return result({ ...startedTask(task, resolvedFields), selection, ...(await warningsFor(cwd, task)) });
  });
  server.registerTool("route", {
    description: "Choose a profile and model for a proposed task without starting it. Use before delegate to compare providers by quality, cost, speed, and available rate-limit headroom, especially when the current provider is low on usage.",
    inputSchema: z.object({
      prompt: z.string().min(1).max(64_000),
      modelHint: z.string().min(1).max(200).optional(),
      preference: z.enum(["balanced", "quality", "cost", "speed"]).optional(),
      cwd: z.string().min(1),
    }),
  }, async ({ prompt, modelHint, preference, cwd }) => result(
    await routeModel(prompt, { modelHint, preference, cwd }),
  ));
  server.registerTool("inspect", {
    description: "Get one task's record: output, scope, grant, spend, and completion. By default the three heaviest fields (prompt, shippedPrompt and attempts) are opt-in — pass `fields: [\"all\"]` for the full snapshot. The read that a settled watch line or a wait response hands off to.",
    inputSchema: z.object({
      taskId: z.string().describe("Inter task id returned by delegate, reply, or resume."),
      fields: taskFieldSchema,
    }),
  }, async ({ taskId, fields }) => {
    const task = getTask(taskId);
    if (!task) throw new Error(unknownTaskMessage(taskId));
    return result(taskView(task, fields ?? DEFAULT_INSPECT_FIELDS));
  });
  server.registerTool("wait", {
    description: "The right call for a short deliberate block: a sanity check right after dispatch, a reply-then-wait exchange, or a harness with no background shell. Checks one to eight delegated tasks for new progress, a question, or completion, and blocks for real — up to 30s regardless of what timeoutMs asks for. To actually follow a task, background `" + watchCommand() + "` in your own shell tool instead: it sleeps for free and reports the moment the task needs you, no turn spent watching it. When you do call wait, until: \"attention\" is what makes the block worth it — it returns the moment a task asks a question or reaches a terminal state, and calling it again after it returns empty is the correct way to keep checking, not a mistake. Returns only what moves — state, updatedAt, and how the run ended; pass `fields: [\"output\"]` to read a finished run without a second call. Heartbeats do not count as progress.",
    inputSchema: z.object({
      taskIds: z.array(z.string()).min(1).max(8)
        .describe("Inter task ids to check together."),
      timeoutMs: z.number().int().min(0).max(300_000).default(0)
        .describe("Requested block, clamped to 30s. Leave at 0 for an immediate read."),
      afterCursor: z.number().int().min(0).optional()
        .describe(
          "Cursor from an earlier wait on this same set of taskIds. A cursor belongs to the set that produced it — reusing one across a different set replays or skips events.",
        ),
      until: z.enum(["progress", "attention"]).default("progress")
        .describe("progress returns on any new event; attention returns only on a question or a terminal state."),
      fields: taskFieldSchema,
    }),
  }, async ({ taskIds, timeoutMs, afterCursor, until, fields }, extra) => {
    const waited = await waitForTasks(
      taskIds,
      mcpWaitBlockMs(timeoutMs),
      extra.mcpReq.signal,
      afterCursor,
      until,
    );
    return result({
      ...waited,
      tasks: waited.tasks.map((task) => waitTaskView(task, fields)),
      ...(waited.events ? { events: waitEventsView(waited.events) } : {}),
    });
  });
  server.registerTool("health", {
    description: "Check whether the Inter broker is running and read its broker and MCP contract versions. Use for connection or compatibility diagnosis, not worker availability.",
    inputSchema: z.object({}),
  }, async () => result({ status: "ok", version: VERSION, mcpContractVersion: MCP_CONTRACT_VERSION }));
  server.registerTool("tasks", {
    description: "Find recent delegated tasks by state, time, profile, or fan-out batch. Returns concise summaries for discovery; use inspect for one task in full, or background watch to follow active work.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).default(20),
      state: taskStateSchema.optional().describe("Only tasks currently in this state."),
      since: z.string().datetime().optional().describe("Only tasks updated at or after this ISO timestamp."),
      profile: z.string().optional().describe("Only tasks sent to this profile id."),
      parent: z.string().optional()
        .describe("A fan-out batch: the task with this id plus every task delegated with it as parent."),
      archived: z.enum(["active", "only", "include"]).default("active"),
    }),
  }, async (query) => result(listTaskSummaries(query).map(publicTaskSummary)));
  server.registerTool("memory", {
    description: "Read or update durable project facts shared across Inter callers and delegated workers. Delegation automatically includes active memories for its cwd. Store decisions, constraints, and conventions; never store secrets or transient task status. Use expectedVersion to prevent concurrent overwrites.",
    inputSchema: z.object({
      action: z.enum(["list", "get", "set", "remove"]),
      cwd: z.string().min(1),
      key: z.string().optional(),
      value: z.string().optional(),
      expectedVersion: z.number().int().min(0).optional(),
    }),
  }, async ({ action, cwd, key, value, expectedVersion }) => {
    if (action === "list") return result(listMemories(cwd));
    if (!key) throw new Error(`memory ${action} requires key`);
    if (action === "get") return result(getMemory(cwd, key) ?? null);
    if (action === "set") {
      if (value === undefined) throw new Error("memory set requires value");
      return result(setMemory(cwd, key, value, expectedVersion));
    }
    return result({ removed: deleteMemory(cwd, key, expectedVersion) });
  });
  server.registerTool("reply", {
    description: "Answer a question from a task in needs_input state. Pass only its Inter task ID; Inter maps it to the private provider session and returns the same task ID. Optional scope is granted with the answer, replacing the task's scope and becoming the cwd's grant. By default a small acknowledgement; pass `fields` to get more.",
    inputSchema: z.object({
      taskId: z.string(),
      answer: z.string().min(1),
      scope: scopeSchema.optional(),
      fields: taskFieldSchema,
    }),
  }, async ({ taskId, answer, scope, fields }) => result(startedTask(await reply(taskId, answer, { scope }), fields ?? DEFAULT_REPLY_FIELDS)));
  server.registerTool("resume", {
    description: "Retry a failed, cancelled, or blocked task on the same profile and the same provider session. Pass only its Inter task ID; Inter maps it to the private root provider session and returns the same task ID. Optional scope and allowQuestions replace those task settings before continuation; get explicit approval before expanding scope. Use reply instead when the task needs input, and handoff when the account itself failed and cannot answer — a rate-limited task carries completion.resetsAt, the time this session becomes resumable again. By default a small acknowledgement; pass `fields` to get more.",
    inputSchema: z.object({
      taskId: z.string(),
      instruction: z.string().min(1).max(64_000).optional(),
      timeoutMs: z.number().int().min(1).max(86_400_000).optional(),
      scope: scopeSchema.optional(),
      allowQuestions: z.boolean().optional(),
      fields: taskFieldSchema,
    }),
  }, async ({ taskId, instruction, timeoutMs, scope, allowQuestions, fields }) =>
    result(startedTask(await resumeTask(taskId, instruction, { timeoutMs, scope, allowQuestions }), fields ?? DEFAULT_RESUME_FIELDS)));
  server.registerTool("handoff", {
    description: HANDOFF_DESCRIPTION,
    inputSchema: z.object({
      taskId: z.string().describe("Inter task id of the failed, cancelled, or blocked task."),
      profile: z.string().min(1)
        .describe("Destination profile id. Must differ from the task's current profile; see profiles for capacity."),
      model: z.string().min(1).max(200).optional()
        .describe("Model on the destination profile. Omit for that profile's default."),
      effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional()
        .describe("Reasoning effort for the new run. Omit to keep what the task already asked for."),
      scope: scopeSchema.optional()
        .describe(
          "Fresh approval for the destination, which becomes this cwd's grant for it. " +
          "Omit and the task keeps its own scope — never widened — and the response warns that it was approved for the profile being left.",
        ),
      fields: taskFieldSchema,
    }),
  }, async ({ taskId, profile, model, effort, scope, fields }) => {
    const task = await handoffTask(taskId, profile, { model, effort, scope });
    return result({
      ...startedTask(task, fields ?? DEFAULT_HANDOFF_FIELDS),
      ...(await warningsFor(task.cwd, task)),
    });
  });
  server.registerTool("cancel", {
    description: "Stop a delegated task and its worker process tree. Works on queued, running, needs_input, and blocked tasks, so a task parked on a question you do not want to answer is not a dead end. This does not delete the task record. By default a small acknowledgement; pass `fields` to get more.",
    inputSchema: z.object({
      taskId: z.string(),
      reason: z.string().min(1).max(500).optional()
        .describe("Stored as the task error and shown to the user."),
      fields: taskFieldSchema,
    }),
  }, async ({ taskId, reason, fields }) => result(taskView(await cancelTask(taskId, reason), fields ?? DEFAULT_CANCEL_FIELDS)));
  server.registerTool("complete", {
    description: COMPLETE_DESCRIPTION,
    inputSchema: z.object({
      taskId: z.string(),
      assertedBy: z.string().min(1).max(200)
        .describe("Who or what verified the work landed: your name, the client, the integration."),
      reason: z.string().min(1).max(500)
        .describe("Why the work demonstrably landed despite the recorded outcome. Required; an empty reason is rejected."),
      fields: taskFieldSchema,
    }),
  }, async ({ taskId, assertedBy, reason, fields }) =>
    result(taskView(await assertTaskCompletion(taskId, assertedBy, reason), fields ?? DEFAULT_COMPLETE_FIELDS)));
  server.registerTool("archive", {
    description: "Archive or restore a delegated task without deleting its history. Archived tasks stay addressable by Inter task ID and are hidden from active task lists by default. Returns the core acknowledgement (id, state); pass `fields` to get more.",
    inputSchema: z.object({
      taskId: z.string(),
      archived: z.boolean().default(true),
      fields: taskFieldSchema,
    }),
  }, async ({ taskId, archived, fields }) => result(taskView(setTaskArchived(taskId, archived), fields ?? DEFAULT_ARCHIVE_FIELDS)));
  server.registerTool("profiles", {
    description: "Everything needed to pick a destination: configured provider profiles with their capabilities and default models, plus — on request — their model catalogs, availability, and rate-limit headroom. This is the one capacity read; use route to have Inter choose for you.",
    inputSchema: z.object({
      profile: z.string().optional().describe("Restrict to one profile id."),
      provider: z.enum(["claude", "codex", "opencode", "antigravity", "pi"]).optional()
        .describe("Restrict to one provider."),
      include: z.array(z.enum(["models", "status", "usage"])).optional()
        .describe(
          "Extra sections to fetch. models lists model ids; status reports whether a profile answers; " +
          "usage reports session and weekly quota. Each costs a provider call, so ask only for what you will use.",
        ),
      refresh: z.boolean().optional()
        .describe("Bypass the five-minute cache for the requested sections."),
    }),
  }, async ({ profile, provider, include, refresh }) => {
    const query = { profile, ...(provider ? { provider } : {}), refresh };
    const wanted = new Set(include ?? []);
    const [models, status, usage] = await Promise.all([
      wanted.has("models") ? listModels(query) : undefined,
      wanted.has("status") ? listProfileStatuses(query) : undefined,
      wanted.has("usage") ? listProfileUsage(query) : undefined,
    ]);
    const profiles = publicProfiles((await loadConfig()).profiles)
      .filter((item) => (!profile || item.id === profile) && (!provider || item.provider === provider));
    return result({
      profiles,
      ...(models ? { models } : {}),
      ...(status ? { status } : {}),
      ...(usage ? { usage } : {}),
    });
  });
  return server;
}

/** Everything about this dispatch the caller should repeat back to the user. */
async function warningsFor(cwd: string, task: Task): Promise<{ warnings?: string[] }> {
  const warnings = [
    ...(scopeInheritanceWarning(task) ? [scopeInheritanceWarning(task)!] : []),
    ...await policyWarnings(cwd, task),
  ];
  return warnings.length > 0 ? { warnings } : {};
}

/**
 * `.inter.toml` only ever steered automatic routing, so naming a profile
 * silently sidestepped the project's own policy. Delegation still proceeds —
 * the file is a policy, not a lock — but it no longer does so quietly.
 */
async function policyWarnings(cwd: string, task: Task): Promise<string[]> {
  const policy = await loadRoutingPolicy(cwd).catch(() => undefined);
  if (!policy) return [];
  const allowed = Object.values(policy.routes).flatMap((route) => route?.allow ?? []);
  if (allowed.length === 0) return [];
  const config = await loadConfig();
  const provider = config.profiles.find(({ id }) => id === task.profileId)?.provider;
  if (allowed.some((entry) => entry.provider === provider && entry.model === task.model)) return [];
  return [
    `${provider}/${task.model} is not in any allow list in ${policy.path}; the explicit profile overrode project routing policy`,
  ];
}

/**
 * JSON bodies are caller input, so a syntax error is a 400, never a 500.
 * `undefined` is the failure marker because no valid JSON parses to it.
 */
async function readJson(request: Request): Promise<unknown | undefined> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** The malformed-JSON answer, in the one shape every body-reading route shares. */
function invalidJsonBody(): Response {
  return Response.json({ error: "invalid JSON body" }, { status: 400 });
}

/** The first problem, phrased the way a form would: `scope.write: expected array, received string`. */
function describeZodIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid body";
  const where = issue.path.length > 0 ? issue.path.join(".") : "body";
  return `${where}: ${issue.message}`;
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function startedTask(task: Task, fields: readonly TaskField[]) {
  return {
    ...taskView(task, fields),
    cursor: stateStore().latestTaskEventId([task.id], true),
  };
}

function publicProfiles(profiles: Profile[]) {
  return profiles.map(publicProfile);
}

function publicProfile(profile: Profile): Profile {
  return {
    ...profile,
    env: Object.fromEntries(Object.entries(profile.env).map(([key, value]) => [
      key,
      /(?:KEY|TOKEN|SECRET|PASS)/i.test(key) ? "••••••••" : value,
    ])),
  };
}

function archiveFilter(value: string | null): "active" | "only" | "include" {
  return value === "only" || value === "include" ? value : "active";
}
