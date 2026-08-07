/**
 * What `inter` says to someone who just installed it and typed the name. The
 * command list here is the one the unknown-command error names, so a typo can
 * never be told about a command help does not print.
 */
export const COMMAND_NAMES = ["serve", "watch", "inflight", "cleanup", "config", "version", "help"] as const;

/** Every spelling that means "tell me what this is". */
const HELP_FLAGS = new Set(["help", "--help", "-h"]);

export function isHelpRequest(command: string): boolean {
  return HELP_FLAGS.has(command);
}

export function helpText(): string {
  return `Inter hands a task to one of your other AI accounts, runs it in the background
with only the files you allow, and tells you the moment it needs you or finishes.

Usage: inter <command> [options]

  serve                Run the broker: the background service your coding
                       agents and the Inter app talk to. The app starts it for
                       you, so you rarely type this.
  watch <task-id>...   Wait for a task. Prints one line the moment it asks a
                       question, fails, or finishes, then exits. Run it with no
                       id to see its options.
  inflight             List the tasks still running, so you know what stopping
                       the service would interrupt.
  cleanup              Free the disk that old finished work is holding. Shows
                       what would go and deletes nothing until you say so.
  config [cwd]         Print the effective config for a directory — profiles,
                       routes, worker rules — and which file each setting came
                       from. Defaults to the current directory.
  version              Print which build of Inter this is.
  help                 Print this.

First run:

  1. inter serve &  — unless the Inter app is already running it.
  2. Connect your coding agent to http://127.0.0.1:7331/mcp. The Inter app's
     Install MCP button does this for every client it finds.
  3. Ask your agent to delegate a task, then follow it:
     inter watch <task-id> &`;
}

export function unknownCommandMessage(command: string): string {
  return `unknown command '${command}'\n` +
    `Commands: ${COMMAND_NAMES.join(", ")}. Run 'inter help' for what each one does.`;
}
