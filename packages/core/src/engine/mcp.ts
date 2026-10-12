import { createMcpHub, type McpHub } from "@nexo/mcp";
import type { Logger } from "@nexo/telemetry";
import type { NexoConfig } from "../config/schema.ts";

/** Timeout of one MCP tool call when the server sets none: long enough to approve a browser connection. */
export const DEFAULT_MCP_TIMEOUT_MS = 120_000;

/** The hub for `config.mcp.servers`, or null when none is configured. Servers start on the first run that lists tools. */
export function createConfiguredMcpHub(config: NexoConfig, options: { cwd: string; logger: Logger }): McpHub | null {
	const entries = Object.entries(config.mcp.servers);
	if (entries.length === 0) return null;
	const servers = Object.fromEntries(
		entries.map(([name, s]) => [name, { command: s.command, args: s.args ?? [], env: s.env ?? {}, timeoutMs: s.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS }]),
	);
	return createMcpHub({ servers, cwd: options.cwd, onWarning: (message, context) => options.logger.warn(message, context) });
}
