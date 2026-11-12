import { readFileSync } from "node:fs";
import { createModels, type Context } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { type CodexCatalog, CODEX_P_PROVIDER, codexPProvider, type CodexPRequest, codexReplySchema, nexoModels, parseCodexReply } from "../src/index.ts";

const CATALOG: CodexCatalog = {
	models: [
		{
			slug: "gpt-6-astra",
			base_instructions: "You are Codex.",
			tool_mode: "code_mode_only",
			shell_type: "unified_exec",
			multi_agent_version: "v2",
			apply_patch_tool_type: "freeform",
			model_messages: { persistent_instructions: "x" },
			experimental_supported_tools: ["clock"],
			supports_search_tool: true,
			context_window: 272000,
		},
		{ slug: "gpt-6-sol", base_instructions: "keep" },
	],
};

function fakeRun(lines: object[], exit: { code: number | null; stderr: string } = { code: 0, stderr: "" }) {
	const requests: CodexPRequest[] = [];
	const catalogs: CodexCatalog[] = [];
	const run = (request: CodexPRequest) => {
		requests.push(request);
		// The provider deletes its temp dir afterwards, so read the catalog while the call is running.
		const flag = request.args.find((a) => a.startsWith("model_catalog_json="));
		if (flag) catalogs.push(JSON.parse(readFileSync(JSON.parse(flag.slice("model_catalog_json=".length)) as string, "utf8")) as CodexCatalog);
		return {
			lines: (async function* () {
				for (const l of lines) yield JSON.stringify(l);
			})(),
			exit: Promise.resolve(exit),
		};
	};
	return { run, requests, catalogs };
}

const started = [{ type: "thread.started", thread_id: "t1" }, { type: "turn.started" }];
const completed = { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0 } };
const message = (text: string) => ({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } });

function modelsWith(run: ReturnType<typeof fakeRun>["run"], catalog: () => Promise<CodexCatalog> = async () => structuredClone(CATALOG)) {
	const models = createModels();
	models.setProvider(codexPProvider({ run, catalog }));
	return models;
}

const argAfter = (args: string[], flag: string, nth = 0): string | undefined => {
	let seen = 0;
	for (let i = 0; i < args.length - 1; i++) if (args[i] === flag && seen++ === nth) return args[i + 1];
	return undefined;
};

const user = (content: string) => ({ messages: [{ role: "user" as const, content, timestamp: 1 }] });

describe("codex-p provider", () => {
	it("registers the openai-codex catalog under codex-p in nexoModels", () => {
		const models = nexoModels();
		expect(models.getModel(CODEX_P_PROVIDER, "gpt-6-astra")).toMatchObject({ provider: "codex-p", api: "codex-p" });
		expect(models.getModel(CODEX_P_PROVIDER, "gpt-6-astra")?.contextWindow).toBeGreaterThan(0);
	});

	it("strips Codex's prompt and tools and returns text with effort and usage mapped", async () => {
		const { run, requests, catalogs } = fakeRun([...started, { type: "item.completed", item: { type: "reasoning", text: "thinking" } }, message("Hello"), completed]);
		const models = modelsWith(run);
		const model = models.getModel(CODEX_P_PROVIDER, "gpt-6-astra")!;
		const msg = await models.completeSimple(model, { systemPrompt: 'Be "terse".', ...user("hi") }, { reasoning: "minimal" });

		expect(msg.stopReason).toBe("stop");
		expect(msg.content).toEqual([
			{ type: "thinking", thinking: "thinking" },
			{ type: "text", text: "Hello" },
		]);
		expect(msg.usage).toMatchObject({ input: 60, cacheRead: 40, output: 7, totalTokens: 107 });

		const req = requests[0]!;
		expect(req.stdin).toBe("hi");
		expect(req.args.slice(0, 2)).toEqual(["exec", "--json"]);
		expect(req.args).toEqual(expect.arrayContaining(["--ephemeral", "--ignore-user-config", "--ignore-rules", "-s", "read-only", "-m", "gpt-6-astra"]));
		expect(req.args).toEqual(expect.arrayContaining(['web_search="disabled"', "skills.include_instructions=false", "include_environment_context=false"]));
		expect(req.args).toEqual(expect.arrayContaining(["--disable", "shell_tool", "unified_exec", "multi_agent", "code_mode"]));
		expect(req.args.some((a) => a.startsWith("developer_instructions="))).toBe(false);
		expect(req.args.at(-1)).toBe("-");
		expect(argAfter(req.args, "-c", 0)).toBe('model_reasoning_effort="low"');
		expect(req.args).not.toContain("--output-schema");

		const [astra, sol] = catalogs[0]!.models;
		expect(astra).toMatchObject({
			slug: "gpt-6-astra",
			base_instructions: 'Be "terse".',
			tool_mode: "direct_model_only",
			shell_type: "disabled",
			experimental_supported_tools: [],
			supports_search_tool: false,
			context_window: 272000,
		});
		expect(astra).not.toHaveProperty("multi_agent_version");
		expect(astra).not.toHaveProperty("model_messages");
		expect(astra).not.toHaveProperty("apply_patch_tool_type");
		expect(sol).toEqual({ slug: "gpt-6-sol", base_instructions: "keep" });
	});

	it("turns the schema-constrained reply into tool calls, with the actions in the base instructions", async () => {
		const reply = JSON.stringify({ text: "Reading it.", tool_calls: [{ name: "read", arguments_json: JSON.stringify({ path: "a.ts" }) }] });
		const { run, requests, catalogs } = fakeRun([...started, message(reply), completed]);
		const models = modelsWith(run);
		const context: Context = {
			systemPrompt: "Agent.",
			tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String(), limit: Type.Optional(Type.Number()) }) }],
			...user("open a.ts"),
		};
		const msg = await models.completeSimple(models.getModel(CODEX_P_PROVIDER, "gpt-6-astra")!, context);

		expect(msg.stopReason).toBe("toolUse");
		expect(msg.content[0]).toEqual({ type: "text", text: "Reading it." });
		expect(msg.content[1]).toMatchObject({ type: "toolCall", name: "read", arguments: { path: "a.ts" } });
		expect(argAfter(requests[0]!.args, "--output-schema")).toMatch(/reply-schema\.json$/);
		const instructions = catalogs[0]!.models[0]!.base_instructions as string;
		expect(instructions).toMatch(/^Agent\./);
		expect(instructions).toContain("# Actions");
	});

	it("loads the catalog once across calls", async () => {
		const { run } = fakeRun([...started, message("ok"), completed]);
		let loads = 0;
		const models = modelsWith(run, async () => {
			loads++;
			return structuredClone(CATALOG);
		});
		const model = models.getModel(CODEX_P_PROVIDER, "gpt-6-astra")!;
		await models.completeSimple(model, user("a"));
		await models.completeSimple(model, user("b"));
		expect(loads).toBe(1);
	});

	it("fails without spawning codex exec when the model is not in Codex's catalog", async () => {
		const { run, requests } = fakeRun([...started, message("ok"), completed]);
		const models = modelsWith(run, async () => ({ models: [] }));
		const msg = await models.completeSimple(models.getModel(CODEX_P_PROVIDER, "gpt-6-astra")!, user("x"));
		expect(msg.stopReason).toBe("error");
		expect(msg.errorMessage).toBe("codex exec failed: model gpt-6-astra is not in the Codex CLI's model catalog (codex debug models)");
		expect(requests).toHaveLength(0);
	});

	it("builds a strict schema that names the tools", () => {
		const schema = codexReplySchema([{ name: "read", description: "", parameters: Type.Object({ path: Type.String() }) }]) as any;
		expect(schema.additionalProperties).toBe(false);
		expect(schema.properties.tool_calls.items.properties.name.enum).toEqual(["read"]);
		expect(schema.properties.tool_calls.items.required).toEqual(["name", "arguments_json"]);
	});

	it("parses bad arguments as {} and non-JSON replies as text", () => {
		expect(parseCodexReply('{"text":"","tool_calls":[{"name":"read","arguments_json":"not json"}]}').calls[0]).toMatchObject({ name: "read", arguments: {} });
		expect(parseCodexReply("plain words")).toEqual({ text: "plain words", calls: [] });
	});

	it("reports turn.failed as an error", async () => {
		const { run } = fakeRun([...started, { type: "error", message: "Your access token could not be refreshed." }, { type: "turn.failed", error: { message: "Your access token could not be refreshed." } }], { code: 1, stderr: "" });
		const models = modelsWith(run);
		const msg = await models.completeSimple(models.getModel(CODEX_P_PROVIDER, "gpt-6-astra")!, user("x"));
		expect(msg.stopReason).toBe("error");
		expect(msg.errorMessage).toBe("codex exec failed: Your access token could not be refreshed.");
	});

	it("reports stderr when the CLI exits without completing a turn", async () => {
		const { run } = fakeRun([], { code: null, stderr: "spawn codex ENOENT" });
		const models = modelsWith(run);
		const msg = await models.completeSimple(models.getModel(CODEX_P_PROVIDER, "gpt-6-astra")!, user("x"));
		expect(msg.errorMessage).toBe("codex exec failed: spawn codex ENOENT");
	});
});
