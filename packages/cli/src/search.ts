import { parseArgs } from "node:util";
import { createSettings, DEFAULT_CONFIG, keyStatusLabel, nexoModels } from "@nexo/core";
import { ensureNexoDirs, resolveNexoPaths } from "@nexo/store";
import { escapeControlKeepLines } from "@nexo/tui";
import { formatSearchOutcome, MAX_SEARCH_RESULTS, noKeyMessage, SEARCH_PROVIDER_IDS, type SearchProviderId, webSearch } from "@nexo/tools";
import { NexoError } from "@nexo/telemetry";
import { type CliIO, type CliOptions, EXIT_SIGINT, usageError } from "./common.ts";
import { openLogger } from "./runtime.ts";

/**
 * `nexo search <query...> [--count <n>] [--json]`: the agent's web_search without a model, for checking keys and
 * results. Exit 0 when at least one provider answered, 4 when none has a key, 1 when all failed.
 */
export async function searchCommand(args: string[], io: CliIO, options: CliOptions): Promise<number> {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { count: { type: "string" }, json: { type: "boolean" } } });
	const query = positionals.join(" ").trim();
	if (!query) throw usageError("nexo search needs a query");
	const env = options.env ?? process.env;
	const paths = resolveNexoPaths(env);
	ensureNexoDirs(paths);
	const settings = createSettings({ paths, cwd: options.cwd ?? process.cwd(), env, models: options.models ?? nexoModels() });
	openLogger(settings, paths, "search");
	let count = DEFAULT_CONFIG.tools.webSearch.count;
	try {
		count = settings.loadConfig().config.tools.webSearch.count;
	} catch {
		// Searching needs no models: an incomplete config (first run) keeps the default count.
	}
	if (values.count !== undefined) {
		count = Number(values.count);
		if (!Number.isInteger(count) || count < 1 || count > MAX_SEARCH_RESULTS) throw usageError(`--count must be an integer from 1 to ${MAX_SEARCH_RESULTS}`);
	}
	const keys = Object.fromEntries(SEARCH_PROVIDER_IDS.map((id) => [id, settings.resolveApiKey(id)])) as Partial<Record<SearchProviderId, string>>;
	if (!SEARCH_PROVIDER_IDS.some((id) => keys[id])) {
		throw new NexoError({ code: "PROVIDER_AUTH", message: "No web search key is set", hint: noKeyMessage() });
	}
	const outcome = await webSearch(query, { keys, count, ...(options.searchFetch ? { fetch: options.searchFetch } : {}) }, options.signal);
	if (options.signal?.aborted) return EXIT_SIGINT;
	if (values.json) io.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
	else {
		io.stdout.write(`${escapeControlKeepLines(formatSearchOutcome(query, outcome))}\n`);
		const used = settings.keyProviders().filter((k) => k.purpose === "search" && k.state !== "unset");
		io.stderr.write(`searched ${outcome.answered.join(", ") || "nothing"} · keys: ${used.map((k) => `${k.provider} ${keyStatusLabel(k)}`).join(", ")}\n`);
	}
	return outcome.answered.length > 0 ? 0 : 1;
}
