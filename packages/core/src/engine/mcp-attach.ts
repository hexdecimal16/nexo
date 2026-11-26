import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { McpHub } from "@nexo/mcp";
import { Type } from "typebox";

/** The tool that starts an on-demand MCP server (`mcp.servers.<name>.deferred`) and adds its tools to the run. */
export const ATTACH_MCP_TOOL = "attach_mcp_server";

const AttachParams = Type.Object({
	server: Type.String({ description: "Name of an on-demand MCP server, as listed in this tool's description" }),
});

export interface AttachMcpToolOptions {
	hub: McpHub;
	/** Names of the servers configured with `deferred: true`. */
	servers: readonly string[];
	/** Receives the tools of a server once it is attached; the run adds them before its next model request. */
	onAttach: (tools: AgentTool<any>[]) => void;
}

/**
 * `attach_mcp_server`: starts one on-demand server and hands its tools to the run, once per server. Its tools still go
 * through the tool policy and the approver on every call; attaching only makes them callable.
 */
export function createAttachMcpTool(options: AttachMcpToolOptions): AgentTool<typeof AttachParams> {
	const names = [...options.servers];
	const attached = new Map<string, string[]>();
	const attaching = new Map<string, Promise<string[]>>();
	const attach = (server: string): Promise<string[]> => {
		const done = attached.get(server);
		if (done) return Promise.resolve(done);
		let pending = attaching.get(server);
		if (!pending) {
			pending = options.hub.tools({ only: [server] }).then((tools) => {
				attaching.delete(server);
				if (tools.length === 0) return [];
				options.onAttach(tools);
				const toolNames = tools.map((t) => t.name);
				attached.set(server, toolNames);
				return toolNames;
			});
			attaching.set(server, pending);
		}
		return pending;
	};
	return {
		name: ATTACH_MCP_TOOL,
		label: "Attach MCP server",
		description: `Start an MCP server that loads on demand and add its tools to this run. On-demand servers: ${names.join(", ")}. Call it once, before the first use of that server's tools; they are available from your next step.`,
		parameters: AttachParams,
		execute: async (_id, params) => {
			const server = params.server.trim();
			if (!names.includes(server)) {
				return { content: [{ type: "text", text: `Unknown on-demand MCP server "${server}". On-demand servers: ${names.join(", ")}` }], details: undefined, isError: true };
			}
			const already = attached.has(server);
			const toolNames = await attach(server);
			if (toolNames.length === 0) {
				return { content: [{ type: "text", text: `MCP server "${server}" did not start or lists no tools; the nexo log has the reason.` }], details: undefined, isError: true };
			}
			const text = already
				? `MCP server "${server}" is already attached. Its tools: ${toolNames.join(", ")}`
				: `Attached MCP server "${server}" with ${toolNames.length} tools: ${toolNames.join(", ")}. They are available from your next step.`;
			return { content: [{ type: "text", text }], details: undefined };
		},
	};
}
