export const MAX_MCP_WAIT_BLOCK_MS = 30_000;

export function mcpWaitBlockMs(requestedMs: number): number {
  return Math.min(Math.max(0, requestedMs), MAX_MCP_WAIT_BLOCK_MS);
}
