/**
 * The one build identity: /health serves it, `inter version` prints it, the
 * event-socket hello carries it, and `make install` compares them. One literal
 * in one module, so none of those surfaces can drift.
 */
export const VERSION = "0.6.0";
export const MCP_CONTRACT_VERSION = 22;
