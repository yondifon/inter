import { homedir } from "node:os";
import { join, resolve } from "node:path";

const CONFIG_FILE = ".inter.toml";

/** One parsed config file: its path and its root table. */
export interface TomlLayer {
  path: string;
  root: Record<string, unknown>;
}

/**
 * The layers a read resolves against, highest first. A missing file is a
 * normal absence; a file that fails to parse is an error naming the file.
 */
export interface TomlLayers {
  /** `<cwd>/.inter.toml` — read only when a cwd is given. */
  project?: TomlLayer;
  /** `~/.inter.toml`. */
  user?: TomlLayer;
}

/** Carries the path and field for a consumer to rewrap in its own error type. */
export class TomlConfigError extends Error {
  constructor(
    readonly path: string,
    readonly field: string,
    message: string,
  ) {
    super(`invalid config ${path} at ${field}: ${message}`);
    this.name = "TomlConfigError";
  }
}

export async function loadTomlLayers(cwd?: string): Promise<TomlLayers> {
  const home = Bun.env.HOME ?? homedir();
  const project = cwd === undefined ? undefined : await readLayer(join(resolve(cwd), CONFIG_FILE));
  const user = await readLayer(join(resolve(home), CONFIG_FILE));
  const layers: TomlLayers = {};
  if (project) layers.project = project;
  if (user) layers.user = user;
  return layers;
}

async function readLayer(path: string): Promise<TomlLayer | undefined> {
  let source: string;
  try {
    source = await Bun.file(path).text();
  } catch (error) {
    // EACCES/EPERM behave like a missing file: an unreadable config is not
    // something any read can act on, and worker sandboxes deny the home file
    // while the broker itself can read it.
    if (isAbsentFile(error)) return undefined;
    throw error;
  }

  let raw: unknown;
  try {
    raw = Bun.TOML.parse(source);
  } catch (error) {
    throw new TomlConfigError(path, "syntax", errorMessage(error));
  }
  return { path, root: expectRecord(raw, path, "root") };
}

function expectRecord(value: unknown, path: string, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TomlConfigError(path, field, "must be a table");
  }
  return value as Record<string, unknown>;
}

function isAbsentFile(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
