import { parseArgs } from "node:util";
import { createSettings, nexoModels, type Settings } from "@nexo/core";
import { ensureNexoDirs, resolveNexoPaths } from "@nexo/store";
import { NexoError } from "@nexo/telemetry";
import { nonInteractivePrompter } from "@nexo/tools";
import { type CliIO, type CliOptions, type CliStdio, EXIT_SIGINT, exitCodeFor, printError, requireTerminal, usageError } from "./common.ts";
import { createTtyLineAsker } from "./review.ts";
import { createRuntime } from "./runtime.ts";
import { readHiddenKey } from "./settings.ts";

/** Thrown when the user presses Ctrl-C or input ends during a prompt. */
class Cancelled extends Error {}

const TEST_BUDGET_USD = 0.05;
const CATALOG_LINES = 30;

const WELCOME = [
	"Welcome to nexo.",
	"nexo runs an AI agent on your machine, tracks what each run costs, and stores its data in your nexo home directory.",
	"This setup picks two models (s1 for most work, s2 as the stronger fallback), stores their API keys, and makes one small test call.",
].join("\n");

const NEXT_STEPS = [
	"",
	"Next steps:",
	"  nexo                 start a chat",
	"  nexo run \"<task>\"    run one task",
	"  nexo ui              open the run inspector",
	"  nexo doctor          check your setup",
].join("\n");

/** Model-influenced text shown on the terminal: control characters removed, length capped. */
function clean(text: string, max: number): string {
	const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

async function initBody(args: string[], io: CliIO, options: CliOptions, stdio: CliStdio): Promise<number> {
	const { values } = parseArgs({
		args,
		options: { yes: { type: "boolean" }, s1: { type: "string" }, s2: { type: "string" }, "skip-test": { type: "boolean" } },
	});
	const yes = values.yes === true;
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const signal = options.signal;
	const paths = resolveNexoPaths(env);
	ensureNexoDirs(paths);
	const settings: Settings = createSettings({ paths, cwd, env, models: options.models ?? nexoModels() });
	const say = (text: string): void => {
		io.stderr.write(`${text}\n`);
	};

	let status = settings.setupStatus();
	if (status.error) {
		printError(io, status.error);
		return 1;
	}

	// A finished setup is only reported; nothing is asked or redone.
	if (!status.needed) {
		say("Setup is complete: models s1 and s2 are set.");
		for (const provider of status.providersWithoutKey) say(`  No API key for ${provider}. Run: nexo settings set-key ${provider}`);
		say(NEXT_STEPS);
		return 0;
	}

	if (yes) {
		for (const role of status.missingModels) {
			if (!values[role]) throw usageError(`nexo init --yes needs --${role} <provider/id>`);
		}
	} else {
		requireTerminal(stdio, "nexo init");
	}

	/** One question per readline interface, so the raw-mode key prompt never shares stdin with it. */
	const ask = async (question: string): Promise<string> => {
		const asker = createTtyLineAsker(stdio.stdin, process.stderr);
		try {
			const line = await asker.ask(question, signal);
			if (line === null) throw new Cancelled();
			return line.trim();
		} finally {
			asker.close?.();
		}
	};

	say(WELCOME);
	const catalog = settings.modelCatalog();

	for (const role of status.missingModels) {
		const key = `models.${role}`;
		const given = values[role];
		if (given) {
			settings.setSettingFromString(key, given);
			say(`Set ${key} = ${given}`);
			continue;
		}
		say(`\nChoose the ${role} model (${role === "s1" ? "the default, used for most work" : "the stronger model used when s1 needs help"}).`);
		say(`Providers: ${catalog.map((p) => p.provider).join(", ")}`);
		let chosen = false;
		for (let attempt = 0; attempt < 3 && !chosen; attempt++) {
			const provider = await ask("Provider: ");
			const found = catalog.find((p) => p.provider === provider);
			if (found) {
				say(found.models.slice(0, CATALOG_LINES).map((m) => `  ${m.ref}`).join("\n"));
				if (found.models.length > CATALOG_LINES) say(`  … ${found.models.length - CATALOG_LINES} more`);
			} else {
				say(`Unknown provider "${clean(provider, 40)}"; type one of the names above, or a full provider/id next.`);
			}
			const ref = await ask(`Model ${role} (provider/id): `);
			try {
				settings.setSettingFromString(key, ref);
				say(`Set ${key} = ${ref}`);
				chosen = true;
			} catch (error) {
				say((error as Error).message);
			}
		}
		if (!chosen) {
			throw new NexoError({ code: "INVALID_REQUEST", message: `No valid ${role} model chosen`, hint: `Run \`nexo init\` again, or \`nexo settings set ${key} <provider/id>\`` });
		}
	}

	status = settings.setupStatus();
	for (const provider of status.providersWithoutKey) {
		if (yes) {
			say(`warning: no API key for ${provider}; set its environment variable or run: nexo settings set-key ${provider}`);
			continue;
		}
		say(`\nPress Enter at the prompt to skip ${provider} (fine for keyless or local providers).`);
		const key = await readHiddenKey(stdio.stdin, io.stderr, provider, signal);
		if (key === null) throw new Cancelled();
		if (key === "") {
			say(`Skipped the ${provider} key`);
			continue;
		}
		try {
			settings.setKey(provider, key);
			say(`Stored the ${provider} key`);
		} catch (error) {
			say((error as Error).message);
		}
	}

	if (values["skip-test"]) {
		say("\nSkipped the test call.");
		say(NEXT_STEPS);
		return 0;
	}

	say(`\nTest call on s1 (budget $${TEST_BUDGET_USD.toFixed(2)})…`);
	const runtime = createRuntime({ env, cwd, prompter: nonInteractivePrompter, models: options.models });
	let result: Awaited<ReturnType<typeof runtime.engine.run>>;
	try {
		result = await runtime.engine.run({ instruction: "Reply with the single word: ready", model: "s1", budgetUsd: TEST_BUDGET_USD }, signal);
	} finally {
		await runtime.mcp?.close();
	}
	if (result.status === "succeeded") {
		say(`✓ s1 answered "${clean(result.output, 80)}" · $${result.costUsd.toFixed(4)}${result.costUnknown ? " (unpriced)" : ""}`);
		say(NEXT_STEPS);
		return 0;
	}
	say(`✗ test call ${result.status}`);
	if (result.error) printError(io, result.error, runtime.redact);
	say("Run `nexo doctor` to check keys and config, then `nexo init --skip-test` or fix the cause and retry.");
	if (result.status === "aborted") return EXIT_SIGINT;
	return result.error ? exitCodeFor(result.error.code) : 1;
}

/**
 * `nexo init [--yes] [--s1 <provider/id>] [--s2 <provider/id>] [--skip-test]`: guided first-time setup on top of
 * `Settings.setupStatus()`. Only missing models are asked; a finished setup is reported and left alone. With `--yes`
 * nothing is prompted: models come from flags and a missing key is a warning, so the test call decides the exit code.
 */
export async function initCommand(args: string[], io: CliIO, options: CliOptions, stdio: CliStdio): Promise<number> {
	try {
		return await initBody(args, io, options, stdio);
	} catch (error) {
		if (error instanceof Cancelled) {
			io.stderr.write("cancelled\n");
			return EXIT_SIGINT;
		}
		throw error;
	}
}
