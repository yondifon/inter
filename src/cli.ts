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
  waitForTasks,
} from "./tasks";
import { listModels } from "./models";
import { routeModel } from "./model-router";
import { listProfileStatuses } from "./profile-status";
import { listProfileUsage } from "./usage";
import { stateStore } from "./store";
import type { Profile, Provider, Task } from "./types";
import { dynamicProfileTools } from "./dynamic-tools";
import { finalText } from "./adapters";
import { taskEventView } from "./events";
import { DELEGATE_DESCRIPTION, MCP_INSTRUCTIONS, dynamicDelegateDescription } from "./mcp-copy";
import { defaultModelFor } from "./provider-defaults";
import { normalizeProfile } from "./profile-input";
import { deleteMemory, getMemory, listMemories, setMemory } from "./memories";
import { publicTask, publicTaskSummary } from "./public-task";

const port = Number(Bun.env.INTER_PORT ?? 7331);
const VERSION = "0.4.0";
const MCP_CONTRACT_VERSION = 12;
// Idle transports get cut somewhere above ~2 minutes (field-observed: waits of
// 180s+ died with socket-closed errors, ≤120s never did). Answer before that
// with reason "timeout" and a cursor so clients re-poll instead of erroring.
const MAX_WAIT_BLOCK_MS = 110_000;
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
        tasks: listTasks().map((task) => {
          const profile = config.profiles.find(({ id }) => id === task.profileId);
          return profile && task.output ? { ...task, output: finalText(profile, task.output) } : task;
        }),
        settings: stateStore().getSettings(),
      });
    }
    if (url.pathname === "/api/settings" && request.method === "PUT") {
      const body = await request.json() as { dynamicProfileTools?: unknown };
      if (typeof body.dynamicProfileTools !== "boolean") {
        return Response.json({ error: "dynamicProfileTools must be a boolean" }, { status: 400 });
      }
      const settings = { dynamicProfileTools: body.dynamicProfileTools };
      stateStore().saveSettings(settings);
      return Response.json(settings);
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
      profile: z.string().optional(),
      model: z.string().min(1).max(200).optional(),
      preference: z.enum(["balanced", "quality", "cost", "speed"]).optional(),
      prompt: z.string().min(1).max(64_000),
      cwd: z.string().min(1),
      parent: z.string().optional(),
      scope: scopeSchema,
      allowQuestions: z.boolean().default(true),
      timeoutMs: z.number().int().min(1).max(86_400_000).optional(),
    }),
  }, async ({ profile, model, preference, prompt, cwd, parent, scope, allowQuestions, timeoutMs }) => {
    if (profile) {
      const task = await delegate(profile, prompt, cwd, model, parent, { scope, allowQuestions, timeoutMs });
      return result(startedTask(task));
    }
    const selection = await routeModel(prompt, { preference, modelHint: model, cwd });
    const task = await delegate(selection.profileId, prompt, cwd, selection.model, parent, {
      scope,
      allowQuestions,
      timeoutMs,
    });
    return result({ ...startedTask(task), selection });
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
    description: "Get the full current snapshot of one delegated task by its Inter task ID, including its prompt, output, and state. Use for an immediate lookup; use wait to follow running work.",
    inputSchema: z.object({ taskId: z.string() }),
  }, async ({ taskId }) => {
    const task = getTask(taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    return result(publicTask(task));
  });
  server.registerTool("wait", {
    description: "Follow one to eight delegated tasks until new progress, a question, completion, or timeout. Use after delegate, reply, or resume; pass the returned cursor as afterCursor on the next call. Set until to \"attention\" for long tasks when only questions or terminal states matter. Each call blocks for at most 110 seconds, so call wait again after a timeout.",
    inputSchema: z.object({
      taskIds: z.array(z.string()).min(1).max(8),
      timeoutMs: z.number().int().min(1).max(300_000).default(30_000),
      afterCursor: z.number().int().min(0).optional(),
      until: z.enum(["progress", "attention"]).default("progress"),
    }),
  }, async ({ taskIds, timeoutMs, afterCursor, until }, extra) => {
    const waited = await waitForTasks(
      taskIds,
      Math.min(timeoutMs, MAX_WAIT_BLOCK_MS),
      extra.mcpReq.signal,
      afterCursor,
      until,
    );
    return result({ ...waited, tasks: waited.tasks.map(publicTask) });
  });
  server.registerTool("health", {
    description: "Check whether the Inter broker is running and read its broker and MCP contract versions. Use for connection or compatibility diagnosis, not worker availability.",
    inputSchema: z.object({}),
  }, async () => result({ status: "ok", version: VERSION, mcpContractVersion: MCP_CONTRACT_VERSION }));
  server.registerTool("tasks", {
    description: "Find recent delegated tasks by state, time, or profile. Returns concise summaries for task discovery; use inspect for a task's full prompt and output, or wait to follow active work.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).default(20),
      state: taskStateSchema.optional(),
      since: z.string().datetime().optional(),
      profile: z.string().optional(),
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
    description: "Answer a question from a task in needs_input state. Pass only its Inter task ID; Inter maps it to the private provider session and returns the same task ID.",
    inputSchema: z.object({ taskId: z.string(), answer: z.string().min(1) }),
  }, async ({ taskId, answer }) => result(startedTask(await reply(taskId, answer))));
  server.registerTool("resume", {
    description: "Retry a failed, cancelled, or blocked task. Pass only its Inter task ID; Inter maps it to the private root provider session and returns the same task ID. Use reply instead when the task needs input.",
    inputSchema: z.object({
      taskId: z.string(),
      instruction: z.string().min(1).max(64_000).optional(),
      timeoutMs: z.number().int().min(1).max(86_400_000).optional(),
    }),
  }, async ({ taskId, instruction, timeoutMs }) =>
    result(startedTask(await resumeTask(taskId, instruction, timeoutMs))));
  server.registerTool("cancel", {
    description: "Stop a queued or running delegated task and its worker process tree. Use when the work is no longer useful; this does not delete the task record.",
    inputSchema: z.object({
      taskId: z.string(),
      reason: z.string().min(1).max(500).optional(),
    }),
  }, async ({ taskId, reason }) => result(publicTask(await cancelTask(taskId, reason))));
  server.registerTool("profiles", {
    description: "List configured AI provider profiles, capabilities, and default models. Use to choose a provider for a second opinion or more usage capacity; use status to check availability and models to browse model IDs.",
    inputSchema: z.object({}),
  }, async () => result(publicProfiles((await loadConfig()).profiles)));
  server.registerTool("models", {
    description: "List model IDs offered by enabled CLI account profiles. Use to choose a model for route or delegate; filter by profile or provider, and set refresh to bypass the five-minute catalog cache.",
    inputSchema: z.object({
      profile: z.string().optional(),
      provider: z.enum(["claude", "codex", "opencode", "antigravity"]).optional(),
      refresh: z.boolean().optional(),
    }),
  }, async (query) => result(await listModels(query)));
  server.registerTool("status", {
    description: "Check whether profiles and models are available, unavailable, or unknown. Use before delegation when account or model readiness is uncertain. Refresh performs safe catalog checks without sending a generation prompt; use usage for rate-limit windows.",
    inputSchema: z.object({
      profile: z.string().optional(),
      model: z.string().min(1).max(200).optional(),
      provider: z.enum(["claude", "codex", "opencode", "antigravity"]).optional(),
      refresh: z.boolean().optional(),
    }),
  }, async (query) => result(await listProfileStatuses(query)));
  server.registerTool("usage", {
    description: "Read session and weekly rate-limit usage for each profile without spending inference tokens. Use to find capacity on another provider and spread work across model quotas; use status for availability. Claude and Codex are supported; OpenCode is not.",
    inputSchema: z.object({
      profile: z.string().optional(),
      provider: z.enum(["claude", "codex", "opencode", "antigravity"]).optional(),
      refresh: z.boolean().optional(),
    }),
  }, async (query) => result(await listProfileUsage(query)));
  if (stateStore().getSettings().dynamicProfileTools) {
    for (const { name, profile } of dynamicProfileTools((await loadConfig()).profiles)) {
      server.registerTool(name, {
        description: dynamicDelegateDescription(profile),
        inputSchema: z.object({
          model: z.string().min(1).max(200).optional(),
          prompt: z.string().min(1).max(64_000),
          cwd: z.string().min(1),
          parent: z.string().optional(),
          scope: scopeSchema,
          allowQuestions: z.boolean().default(true),
          timeoutMs: z.number().int().min(1).max(86_400_000).optional(),
        }),
      }, async ({ model, prompt, cwd, parent, scope, allowQuestions, timeoutMs }) => {
        const task = await delegate(profile.id, prompt, cwd, model, parent, {
          scope,
          allowQuestions,
          timeoutMs,
        });
        return result(startedTask(task));
      });
    }
  }
  return server;
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
