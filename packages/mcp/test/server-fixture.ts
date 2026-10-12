import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** A stdio MCP server for tests: `echo` returns its text and the FIXTURE_GREETING environment variable. */
const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
	content: [{ type: "text", text: `${String(request.params.arguments?.text)} ${process.env.FIXTURE_GREETING ?? "-"} ${process.env.OPENAI_API_KEY ?? "no-key"}` }],
}));
await server.connect(new StdioServerTransport());
