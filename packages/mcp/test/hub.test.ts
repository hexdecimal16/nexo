import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createMcpHub, type McpServerSpec, mcpToolName, untrustedNote } from "../src/index.ts";

const spec: McpServerSpec = { command: "unused", args: [], env: {}, timeoutMs: 5000 };

/** A hub whose servers run in memory; `tools` and `call` define each server's behavior. */
function memoryHub(servers: Record<string, { tools: object[]; call?: (name: string, args: unknown) => object } | "broken">) {
	const warnings: string[] = [];
	let starts = 0;
	const hub = createMcpHub({
		servers: Object.fromEntries(Object.keys(servers).map((name) => [name, spec])),
		cwd: process.cwd(),
		onWarning: (message, context) => warnings.push(`${message} ${String(context.server)}`),
		createTransport: (name) => {
			starts++;
			const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
			const def = servers[name];
			if (def === "broken") {
				clientSide.start = async () => {
					throw new Error("spawn failed");
				};
				return clientSide;
			}
			const server = new Server({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
			server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: def?.tools ?? [] }));
			server.setRequestHandler(CallToolRequestSchema, async (req) => def?.call?.(req.params.name, req.params.arguments) ?? { content: [] });
			void server.connect(serverSide);
			return clientSide;
		},
	});
	return { hub, warnings, starts: () => starts };
}

const object = { type: "object", properties: { url: { type: "string" } } };

describe("createMcpHub", () => {
	it("names tools mcp__<server>__<tool>, keeps their schema, and starts each server once", async () => {
		const { hub, starts } = memoryHub({ pw: { tools: [{ name: "browser_navigate", description: "Navigate", inputSchema: object }, { name: "odd.name", inputSchema: { type: "object" } }] } });
		const tools = await hub.tools();
		expect(tools.map((t) => t.name)).toEqual(["mcp__pw__browser_navigate", "mcp__pw__odd_name"]);
		expect(tools[0]?.description).toBe('Navigate (MCP server "pw")');
		expect(tools[0]?.parameters).toMatchObject(object);
		await hub.tools();
		expect(starts()).toBe(1);
		await hub.close();
		expect(await hub.tools()).toEqual([]);
	});

	it("returns text and images behind the untrusted note, and an error result as isError", async () => {
		const { hub } = memoryHub({
			pw: {
				tools: [{ name: "shot", inputSchema: { type: "object" } }, { name: "fail", inputSchema: { type: "object" } }],
				call: (name, args) =>
					name === "shot"
						? { content: [{ type: "text", text: `got ${JSON.stringify(args)}` }, { type: "image", data: "aGk=", mimeType: "image/png" }, { type: "audio", data: "", mimeType: "audio/wav" }] }
						: { content: [{ type: "text", text: "no such element" }], isError: true },
			},
		});
		const [shot, fail] = await hub.tools();
		const ok = await shot?.execute("1", { a: 1 });
		expect(ok?.content).toEqual([
			{ type: "text", text: `${untrustedNote("pw")}\ngot {"a":1}` },
			{ type: "image", data: "aGk=", mimeType: "image/png" },
			{ type: "text", text: "[audio content omitted]" },
		]);
		const bad = await fail?.execute("2", {});
		expect(bad).toMatchObject({ isError: true, content: [{ text: `${untrustedNote("pw")}\nno such element` }] });
		await hub.close();
	});

	it("leaves out a server that fails to start, warns, and tries it again on the next listing", async () => {
		const { hub, warnings, starts } = memoryHub({ broken: "broken", ok: { tools: [{ name: "t", inputSchema: { type: "object" } }] } });
		expect((await hub.tools()).map((t) => t.name)).toEqual(["mcp__ok__t"]);
		expect(warnings).toEqual(["MCP server unavailable; its tools are left out broken"]);
		await hub.tools();
		expect(starts()).toBe(3);
		await hub.close();
	});

	it("skips a tool whose name would pass 64 characters", async () => {
		const long = "x".repeat(60);
		const { hub, warnings } = memoryHub({ pw: { tools: [{ name: long, inputSchema: { type: "object" } }] } });
		expect(await hub.tools()).toEqual([]);
		expect(warnings).toEqual(["MCP tool skipped: name too long pw"]);
		expect(mcpToolName("pw", long).length).toBeGreaterThan(64);
		await hub.close();
	});
});

describe("stdio servers", () => {
	const fixture = fileURLToPath(new URL("./server-fixture.ts", import.meta.url));

	it("runs a server process with the configured environment only, and stops it on close", async () => {
		const saved = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "sk-test-not-for-servers";
		const hub = createMcpHub({
			servers: { fx: { command: process.execPath, args: [fixture], env: { FIXTURE_GREETING: "hello" }, timeoutMs: 10_000 } },
			cwd: process.cwd(),
		});
		const [echo] = await hub.tools();
		const result = await echo?.execute("1", { text: "ping" });
		expect(result?.content).toEqual([{ type: "text", text: `${untrustedNote("fx")}\nping hello no-key` }]);
		await hub.close();
		if (saved === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = saved;
	});

	it("reports a server that exits at once as unavailable", async () => {
		const warnings: unknown[] = [];
		const hub = createMcpHub({
			servers: { gone: { command: process.execPath, args: ["-e", "process.stderr.write('boom'); process.exit(3)"], env: {}, timeoutMs: 10_000 } },
			cwd: process.cwd(),
			onWarning: (_message, context) => warnings.push(context.error),
		});
		expect(await hub.tools()).toEqual([]);
		expect(String((warnings[0] as Error).message)).toMatch(/MCP server "gone" .* did not start/);
		await hub.close();
	});
});
