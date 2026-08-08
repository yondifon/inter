/**
 * The one build identity: /health serves it, `inter version` prints it, the
 * event-socket hello carries it, and `make install` compares them. One literal
 * in one module, so none of those surfaces can drift.
 */
export const VERSION = "0.6.0";
export const MCP_CONTRACT_VERSION = 27;

declare const INTER_BUILD_STAMP: string | undefined;
/**
 * Baked in by `make server` via --define (git sha + build time), "dev" under
 * `bun run`. VERSION alone cannot tell two same-version builds apart — which
 * is exactly the comparison `make install` exists to make: without the stamp,
 * a surviving old broker whose version number matches passes verification
 * while serving yesterday's code.
 */
export const BUILD_STAMP = typeof INTER_BUILD_STAMP === "string" ? INTER_BUILD_STAMP : "dev";
