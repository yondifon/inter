#!/usr/bin/env bun
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";
import { loadConfig, saveConfig } from "./config";
import {
  appendTaskEvent,
  cancelTask,
  delegate,
  getTask,
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
import { finalText } from "./adapters";
import { taskEventView } from "./events";
import { DELEGATE_DESCRIPTION, MCP_INSTRUCTIONS } from "./mcp-copy";
import { defaultModelFor } from "./provider-defaults";
import { normalizeProfile } from "./profile-input";
import { deleteMemory, getMemory, listMemories, setMemory } from "./memories";
import { publicTask, publicTaskSummary, waitTaskView } from "./public-task";
import { mcpWaitBlockMs } from "./mcp-wait";
import { loadRoutingPolicy } from "./routing-policy";

const port = Number(Bun.env.INTER_PORT ?? 7331);
const VERSION = "0.6.0";
const MCP_CONTRACT_VERSION = 19;
// A foreground MCP call still owns the caller's agent turn, which is why
// `until: "attention"` matters: it returns the instant the task needs the
// caller rather than burning the full block.
const scopeSchema = z.object({
  read: z.array(z.string()).max(200),
  write: z.array(z.string()).max(200),
});
const taskStateSchema = z.enum([
  "queued", "running", "needs_input", "answered", "blocked", "completed", "failed", "cancelled",
]);

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
      return Response.json({ status: "ok", version: VERSION, mcpContractVersion: MCP_CONTRACT_VERSION });
    }
    if (url.pathname === "/api/state" && request.method === "GET") {
      const config = await loadConfig();
      return Response.json({
        profiles: publicProfiles(config.profiles),
        tasks: listTasks(archiveFilter(url.searchParams.get("archived"))).map((task) => {
          const profile = config.profiles.find(({ id }) => id === task.profileId);
          return profile && task.output ? { ...task, output: finalText(profile, task.output) } : task;
        }),
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
      if (after > 0 && waitMs > 0 && stateStore().latestTaskEventId([taskId]) <= after && task.state === "running") {
        await waitForTasks([taskId], waitMs, request.signal, after);
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
    const hookTaskId = url.pathname.match(/^\/api\/hooks\/([^/]+)$/)?.[1];
    if (hookTaskId && request.method === "POST") {
      const task = getTask(decodeURIComponent(hookTaskId));
      if (!task) return Response.json({ error: "unknown task" }, { status: 404 });
      const payload = await request.json();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return Response.json({ error: "hook payload must be an object" }, { status: 400 });
      }
      appendTaskEvent(task.id, "agent.hook", task.state, payload as Record<string, unknown>);
      return Response.json({});
    }
    if (url.pathname === "/api/profiles" && request.method === "POST") {
      const config = await loadConfig();
      const profile = normalizeProfile(await request.json());
      if (config.profiles.some((item) => item.id === profile.id)) {
        profile.id = `${profile.id}-${crypto.randomUUID().slice(0, 6)}`;
      }
      config.profiles.push(profile);
      await saveConfig(config);
      return Response.json(publicProfile(profile), { status: 201 });
    }
    if (url.pathname.startsWith("/api/profiles/") && request.method === "PUT") {
      const config = await loadConfig();
      const id = decodeURIComponent(url.pathname.slice("/api/profiles/".length));
      const profile = config.profiles.find((item) => item.id === id);
      if (!profile) return Response.json({ error: "unknown profile" }, { status: 404 });
      const patch = await request.json() as Partial<Profile>;
      if (typeof patch.enabled === "boolean") profile.enabled = patch.enabled;
      if (typeof patch.label === "string" && patch.label.trim()) profile.label = patch.label.trim();
      if (patch.provider && ["claude", "codex", "opencode", "antigravity"].includes(patch.provider)) {
        profile.provider = patch.provider;
      }
      if (Object.hasOwn(patch, "model")) {
        profile.model = typeof patch.model === "string" && patch.model.trim()
          ? patch.model.trim()
          : defaultModelFor(profile.provider);
      }
      if (Array.isArray(patch.capabilities)) profile.capabilities = patch.capabilities.map(String);
      if (patch.env && typeof patch.env === "object") {
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
      const body = await request.json() as {
        profile: string;
        prompt: string;
        cwd: string;
        model?: string;
        parent?: string;
        scope?: { read: string[]; write: string[] };
        allowQuestions?: boolean;
        timeoutMs?: number;
      };
      try {
        const task = await delegate(body.profile, body.prompt, body.cwd, body.model, body.parent, {
          scope: body.scope,
          allowQuestions: body.allowQuestions,
          timeoutMs: body.timeoutMs,
        });
        return Response.json(
          startedTask(task),
          { status: 202 },
        );
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    }
    const patchTaskId = url.pathname.match(/^\/api\/tasks\/([^/]+)$/)?.[1];
    if (patchTaskId && request.method === "PATCH") {
      const body = await request.json() as { archived?: unknown };
      if (typeof body.archived !== "boolean") {
        return Response.json({ error: "archived must be a boolean" }, { status: 400 });
      }
      try {
        return Response.json(publicTask(setTaskArchived(decodeURIComponent(patchTaskId), body.archived)));
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    }
    const cancelTaskId = url.pathname.match(/^\/api\/tasks\/([^/]+)$/)?.[1];
    if (cancelTaskId && request.method === "DELETE") {
      try {
        return Response.json(await cancelTask(
          decodeURIComponent(cancelTaskId),
          url.searchParams.get("reason") ?? undefined,
        ));
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    }
    return new Response("Not found", { status: 404 });
  },
});

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
    inputSchema: z.object({
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
          "Reasoning effort for this run. Honoured by claude, codex, and opencode; antigravity " +
          "ignores it because its level is baked into the model id. Ladders differ per provider, " +
          "so call profiles with include: [\"models\"] and read the model's efforts before choosing.",
        ),
      tldr: z.string().min(1).max(200).optional()
        .describe(
          "One plain sentence, in the user's terms, saying what the task will do and to what; the " +
          "user reads it on the task list, not the prompt. No markdown, no file paths unless they " +
          "are the point.",
        ),
      timeoutMs: z.number().int().min(1).max(86_400_000).optional()
        .describe("Hard runtime limit. The task lands in failed with code timeout."),
    }),
  }, async ({ profile, model, preference, prompt, cwd, parent, scope, allowQuestions, effort, tldr, timeoutMs }) => {
    if (profile) {
      // The caller named the account but not the model. Let the project policy
      // pick that profile's best model for this task class instead of falling
      // back to its single static default, which ignores difficulty entirely.
      const chosen = model ?? await routeModel(prompt, { preference, cwd, profileId: profile })
        .then((route) => route.model)
        .catch(() => undefined);
      const task = await delegate(profile, prompt, cwd, chosen, parent, { scope, allowQuestions, effort, tldr, timeoutMs });
      return result({ ...startedTask(task), ...(await warningsFor(cwd, task)) });
    }
    const selection = await routeModel(prompt, { preference, modelHint: model, cwd });
    const task = await delegate(selection.profileId, prompt, cwd, selection.model, parent, {
      scope,
      allowQuestions,
      effort,
      tldr,
      timeoutMs,
    });
    return result({ ...startedTask(task), selection, ...(await warningsFor(cwd, task)) });
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
    description: "Get the full snapshot of one delegated task: the caller's prompt, the prompt actually shipped to the provider, output, earlier attempts, scope, grant, and spend. Use after wait reports something worth reading in full.",
    inputSchema: z.object({
      taskId: z.string().describe("Inter task id returned by delegate, reply, or resume."),
    }),
  }, async ({ taskId }) => {
    const task = getTask(taskId);
    if (!task) throw new Error(unknownTaskMessage(taskId));
    return result(publicTask(task));
  });
  server.registerTool("wait", {
    description: "Check one to eight delegated tasks for new progress, a question, or completion. Blocks for real — up to 30s — and until: \"attention\" is the way to follow a task: it returns the moment the task asks a question or reaches a terminal state. Calling it again after it returns empty is the correct way to keep following, not a mistake. Returns a prompt preview rather than the prompt, and full output only once a task has settled; use inspect for everything else. Heartbeats do not count as progress.",
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
    }),
  }, async ({ taskIds, timeoutMs, afterCursor, until }, extra) => {
    const waited = await waitForTasks(
      taskIds,
      mcpWaitBlockMs(timeoutMs),
      extra.mcpReq.signal,
      afterCursor,
      until,
    );
    return result({ ...waited, tasks: waited.tasks.map(waitTaskView) });
  });
  server.registerTool("health", {
    description: "Check whether the Inter broker is running and read its broker and MCP contract versions. Use for connection or compatibility diagnosis, not worker availability.",
    inputSchema: z.object({}),
  }, async () => result({ status: "ok", version: VERSION, mcpContractVersion: MCP_CONTRACT_VERSION }));
  server.registerTool("tasks", {
    description: "Find recent delegated tasks by state, time, profile, or fan-out batch. Returns concise summaries for discovery; use inspect for one task in full, or wait to follow active work.",
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
    description: "Answer a question from a task in needs_input state. Pass only its Inter task ID; Inter maps it to the private provider session and returns the same task ID. Optional scope is granted with the answer, replacing the task's scope and becoming the cwd's grant.",
    inputSchema: z.object({
      taskId: z.string(),
      answer: z.string().min(1),
      scope: scopeSchema.optional(),
    }),
  }, async ({ taskId, answer, scope }) => result(startedTask(await reply(taskId, answer, { scope }))));
  server.registerTool("resume", {
    description: "Retry a failed, cancelled, or blocked task. Pass only its Inter task ID; Inter maps it to the private root provider session and returns the same task ID. Optional scope and allowQuestions replace those task settings before continuation; get explicit approval before expanding scope. Use reply instead when the task needs input.",
    inputSchema: z.object({
      taskId: z.string(),
      instruction: z.string().min(1).max(64_000).optional(),
      timeoutMs: z.number().int().min(1).max(86_400_000).optional(),
      scope: scopeSchema.optional(),
      allowQuestions: z.boolean().optional(),
    }),
  }, async ({ taskId, instruction, timeoutMs, scope, allowQuestions }) =>
    result(startedTask(await resumeTask(taskId, instruction, { timeoutMs, scope, allowQuestions }))));
  server.registerTool("cancel", {
    description: "Stop a delegated task and its worker process tree. Works on queued, running, needs_input, and blocked tasks, so a task parked on a question you do not want to answer is not a dead end. This does not delete the task record.",
    inputSchema: z.object({
      taskId: z.string(),
      reason: z.string().min(1).max(500).optional()
        .describe("Stored as the task error and shown to the user."),
    }),
  }, async ({ taskId, reason }) => result(publicTask(await cancelTask(taskId, reason))));
  server.registerTool("archive", {
    description: "Archive or restore a delegated task without deleting its history. Archived tasks stay addressable by Inter task ID and are hidden from active task lists by default.",
    inputSchema: z.object({
      taskId: z.string(),
      archived: z.boolean().default(true),
    }),
  }, async ({ taskId, archived }) => result(publicTask(setTaskArchived(taskId, archived))));
  server.registerTool("profiles", {
    description: "Everything needed to pick a destination: configured provider profiles with their capabilities and default models, plus — on request — their model catalogs, availability, and rate-limit headroom. This is the one capacity read; use route to have Inter choose for you.",
    inputSchema: z.object({
      profile: z.string().optional().describe("Restrict to one profile id."),
      provider: z.enum(["claude", "codex", "opencode", "antigravity"]).optional()
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

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function startedTask(task: Task) {
  return {
    ...publicTask(task),
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
