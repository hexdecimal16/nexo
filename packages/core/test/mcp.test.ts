import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpHub, type McpHub } from "@nexo/mcp";
import { describe, expect, it } from "vitest";
import { createEngine, type DeepPartial, type NexoConfig } from "../src/index.ts";
import { lastToolResultText, makeEnv } from "./helpers.ts";

function snapshotHub(onStart?: () => void): McpHub {
	return createMcpHub({
		servers: { pw: { command: "unused", args: [], env: {}, timeoutMs: 5000 } },
		cwd: process.cwd(),
		createTransport: () => {
			onStart?.();
			const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
			const server = new Server({ name: "pw", version: "1.0.0" }, { capabilities: { tools: {} } });
			server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "browser_snapshot", inputSchema: { type: "object" } }] }));
			server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "- heading \"Inbox\" [ref=e1]" }] }));
			void server.connect(serverSide);
			return clientSide;
		},
	});
}

async function runSnapshot(config: DeepPartial<NexoConfig> = {}) {
	const env = makeEnv({ config });
	const mcp = snapshotHub();
	env.deps.mcp = mcp;
	let toolNames: string[] = [];
	let output = "";
	env.faux.setResponses([
		(context: TranscriptContext) => {
			toolNames = getCurrentTools(context.messages).map((t) => t.name);
			return fauxAssistantMessage([fauxToolCall("mcp__pw__browser_snapshot", {})]);
		},
		(context: TranscriptContext) => {
			output = lastToolResultText(context);
			return fauxAssistantMessage("done");
		},
	]);
	const result = await createEngine(env.deps).run({ instruction: "read the page" });
	await mcp.close();
	return { result, toolNames, output };
}

describe("MCP tools in runs", () => {
	it("are offered to the agent and ask by default, so a run without a prompt is denied", async () => {
		const { toolNames, output } = await runSnapshot();
		expect(toolNames).toContain("mcp__pw__browser_snapshot");
		expect(toolNames).not.toContain("attach_mcp_server");
		expect(output).toContain('Tool "mcp__pw__browser_snapshot" requires approval');
	});

	it("start a deferred server only when the agent attaches it, and offer its tools from the next step", async () => {
		const env = makeEnv({ config: { mcp: { servers: { pw: { command: "unused", deferred: true } } }, tools: { policy: { attach_mcp_server: "allow", "mcp__pw__*": "allow" } } } });
		let starts = 0;
		const mcp = snapshotHub(() => starts++);
		env.deps.mcp = mcp;
		const offered: string[][] = [];
		let startsBeforeAttach = -1;
		let output = "";
		env.faux.setResponses([
			(context: TranscriptContext) => {
				offered.push(getCurrentTools(context.messages).map((t) => t.name));
				startsBeforeAttach = starts;
				return fauxAssistantMessage([fauxToolCall("attach_mcp_server", { server: "pw" })]);
			},
			(context: TranscriptContext) => {
				offered.push(getCurrentTools(context.messages).map((t) => t.name));
				return fauxAssistantMessage([fauxToolCall("mcp__pw__browser_snapshot", {})]);
			},
			(context: TranscriptContext) => {
				output = lastToolResultText(context);
				return fauxAssistantMessage("done");
			},
		]);
		const result = await createEngine(env.deps).run({ instruction: "read the page" });
		await mcp.close();
		expect(result.status).toBe("succeeded");
		expect(startsBeforeAttach).toBe(0);
		expect(offered[0]).toContain("attach_mcp_server");
		expect(offered[0]).not.toContain("mcp__pw__browser_snapshot");
		expect(offered[1]).toContain("mcp__pw__browser_snapshot");
		expect(starts).toBe(1);
		expect(output).toContain('heading "Inbox"');
	});

	it("run when the policy allows them, by name or by a * key", async () => {
		const { output, result } = await runSnapshot({ tools: { policy: { "mcp__pw__*": "allow" } } });
		expect(result.status).toBe("succeeded");
		expect(output).toContain('Output of MCP server "pw"');
		expect(output).toContain('heading "Inbox"');
	});
});
