import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { stateStore } from "./store";
import type { MemoryEntry } from "./types";

const KEY = /^[a-z0-9][a-z0-9._/-]{0,99}$/;

export function listMemories(cwd: string): MemoryEntry[] {
  return stateStore().listMemories(validCwd(cwd));
}

export function getMemory(cwd: string, key: string): MemoryEntry | undefined {
  return stateStore().getMemory(validCwd(cwd), validKey(key));
}

export function setMemory(cwd: string, key: string, value: string, expectedVersion?: number): MemoryEntry {
  const content = value.trim();
  if (!content) throw new Error("memory value must not be empty");
  if (content.length > 16_000) throw new Error("memory value exceeds 16000 characters");
  const project = validCwd(cwd);
  const memoryKey = validKey(key);
  const store = stateStore();
  const existing = store.getMemory(project, memoryKey);
  const memories = store.listMemories(project);
  if (!existing && memories.length >= 100) throw new Error("project memory limit is 100 entries");
  const total = memories.reduce((sum, entry) => sum + entry.value.length, 0)
    - (existing?.value.length ?? 0) + content.length;
  if (total > 64_000) throw new Error("project memory exceeds 64000 characters");
  return store.setMemory(project, memoryKey, content, expectedVersion);
}

export function deleteMemory(cwd: string, key: string, expectedVersion?: number): boolean {
  return stateStore().deleteMemory(validCwd(cwd), validKey(key), expectedVersion);
}

export function promptWithMemories(prompt: string, memories: MemoryEntry[]): string {
  if (memories.length === 0) return prompt;
  const facts = memories.map(({ key, value }) => `- ${key}: ${value}`).join("\n");
  return `${prompt}\n\n## Inter memories\nTreat these project facts as shared context. If one conflicts with the task or current files, report the conflict.\n${facts}`;
}

function validKey(key: string): string {
  if (!KEY.test(key)) {
    throw new Error("memory key must be 1-100 lowercase letters, numbers, dots, slashes, underscores, or hyphens");
  }
  return key;
}

function validCwd(cwd: string): string {
  if (!isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
  const project = resolve(cwd);
  const roots = (Bun.env.INTER_ROOTS ?? homedir()).split(":").filter(Boolean).map((root) => resolve(root));
  if (!roots.some((root) => {
    const child = relative(root, project);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
  })) throw new Error(`cwd is outside INTER_ROOTS: ${project}`);
  if (!statSync(project, { throwIfNoEntry: false })?.isDirectory()) throw new Error("cwd does not exist");
  return project;
}
