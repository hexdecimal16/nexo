import { parseArgs } from "node:util";
import { createSettings, type LearnEvent, type NexoConfig, nexoModels } from "@nexo/core";
import {
	addMemory,
	addPlaybookItem,
	countLearnJobs,
	type Db,
	ensureNexoDirs,
	getActiveArtifact,
	isMemoryType,
	isSkillName,
	listMemories,
	listPlaybookItems,
	type MemoryRow,
	openDb,
	publishPlaybook,
	resolveNexoPaths,
	retireMemory,
	retirePlaybookItem,
	retryFailedLearnJobs,
	transaction,
} from "@nexo/store";
import type { Redactor } from "@nexo/telemetry";
import { nonInteractivePrompter } from "@nexo/tools";
import { escapeControl } from "@nexo/tui";
import { type CliIO, type CliOptions, usageError } from "./common.ts";
import { createRuntime } from "./runtime.ts";

const PREVIEW_CHARS = 100;

function oneLine(text: string, max = PREVIEW_CHARS): string {
	const flat = escapeControl(text.replace(/\s+/g, " ").trim());
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One line per learn job as it finishes. */
export function learnEventLine(event: LearnEvent): string | null {
	if (event.type !== "job_end") return null;
	const run = event.job.runId;
	if (!event.ok) return `  ✗ run ${run}: [${escapeControl(event.error.code)}] ${oneLine(event.error.message, 200)}`;
	const c = event.outcome.curation;
	const parts = [`${event.outcome.lessons} lesson${event.outcome.lessons === 1 ? "" : "s"}`];
	if (c) {
		if (c.memoriesAdded.length) parts.push(`+${c.memoriesAdded.length} memor${c.memoriesAdded.length === 1 ? "y" : "ies"}`);
		if (c.memoriesSuperseded.length) parts.push(`${c.memoriesSuperseded.length} replaced`);
		for (const v of c.playbookVersions) parts.push(`playbook ${v.skill} v${v.version}`);
		if (c.rejected.length) parts.push(`${c.rejected.length} op${c.rejected.length === 1 ? "" : "s"} refused`);
	}
	const cost = event.outcome.costUnknown ? "cost unknown" : `$${event.outcome.costUsd.toFixed(4)}`;
	return `  ✓ run ${run}: ${parts.join(", ")} · ${cost}`;
}

/** `nexo learn [--retry]`: runs pending learn jobs now; `--retry` first puts failed jobs with attempts left back to pending. Exits 1 when a job failed. */
export async function learnCommand(args: string[], io: CliIO, options: CliOptions): Promise<number> {
	const { values } = parseArgs({ args, options: { retry: { type: "boolean" } } });
	const runtime = createRuntime({
		env: options.env ?? process.env,
		cwd: options.cwd ?? process.cwd(),
		prompter: nonInteractivePrompter,
		models: options.models,
		onLearnEvent: (event) => {
			const line = learnEventLine(event);
			if (line) io.stdout.write(`${line}\n`);
		},
	});
	try {
		if (!runtime.config.learning.enabled) {
			io.stdout.write("Learning is off (learning.enabled is false); no job was run.\n");
			return 0;
		}
		if (values.retry) {
			const n = retryFailedLearnJobs(runtime.db, new Date().toISOString());
			io.stdout.write(`Retrying ${n} failed job${n === 1 ? "" : "s"}\n`);
		}
		const drained = await runtime.learner.drain({ signal: options.signal });
		const counts = countLearnJobs(runtime.db);
		io.stdout.write(`${drained.succeeded} succeeded, ${drained.failed} failed · ${counts.pending} pending, ${counts.failed} failed in total\n`);
		if (counts.failed > 0) io.stdout.write("Failed jobs with attempts left run again with `nexo learn --retry`.\n");
		return drained.failed > 0 ? 1 : 0;
	} finally {
		await runtime.mcp?.close();
		runtime.db.close();
	}
}

export interface Store {
	db: Db;
	redact: Redactor;
	config: NexoConfig;
	close(): void;
}

/** The database, the full redactor (config patterns and stored keys) and the config, for the memory, playbook, optimize and eval commands. */
export function openStore(options: CliOptions): Store {
	const env = options.env ?? process.env;
	const paths = resolveNexoPaths(env);
	ensureNexoDirs(paths);
	const settings = createSettings({ paths, cwd: options.cwd ?? process.cwd(), env, models: options.models ?? nexoModels() });
	const { config } = settings.loadConfig();
	const db = openDb(paths.db);
	return { db, redact: settings.redact, config, close: () => db.close() };
}

function memoryLine(m: MemoryRow): string {
	const state = m.retiredAt ? " [retired]" : m.supersededBy ? ` [replaced by ${m.supersededBy}]` : "";
	return `${m.id}  ${m.scope.padEnd(16)} ${m.type.padEnd(10)} ${m.source.padEnd(5)} ${m.importance.toFixed(2)}  ${oneLine(m.content)}${state}`;
}

/** `nexo memory list [--scope s] [--type t] [--all]`, `nexo memory add <text…> [--scope] [--type] [--importance]`, `nexo memory retire <id>`. */
export function memoryCommand(args: string[], io: CliIO, options: CliOptions): number {
	const [sub, ...rest] = args;
	const { values, positionals } = parseArgs({
		args: rest,
		allowPositionals: true,
		options: { scope: { type: "string" }, type: { type: "string" }, importance: { type: "string" }, all: { type: "boolean" }, limit: { type: "string" } },
	});
	if (sub !== "list" && sub !== "add" && sub !== "retire") throw usageError(sub === undefined ? "nexo memory needs list, add or retire" : `Unknown memory subcommand "${sub}"`);
	const store = openStore(options);
	try {
		const now = new Date().toISOString();
		if (sub === "list") {
			const rows = listMemories(store.db, {
				scope: values.scope,
				type: values.type,
				includeInactive: values.all === true,
				limit: values.limit === undefined ? 200 : Number(values.limit),
			});
			for (const m of rows) io.stdout.write(`${memoryLine(m)}\n`);
			io.stdout.write(`${rows.length} memor${rows.length === 1 ? "y" : "ies"}\n`);
			return 0;
		}
		if (sub === "add") {
			const text = positionals.join(" ").trim();
			if (!text) throw usageError("nexo memory add needs the memory text");
			const type = values.type ?? "fact";
			if (!isMemoryType(type)) throw usageError("--type must be fact, preference, lesson or workflow");
			const importance = values.importance === undefined ? 0.8 : Number(values.importance);
			const m = addMemory(store.db, { scope: values.scope ?? "user", type, content: text, importance, source: "user" }, store.redact, now);
			io.stdout.write(`Added memory ${m.id} (${m.scope}, ${m.type})\n`);
			return 0;
		}
		const [id] = positionals;
		if (!id) throw usageError("nexo memory retire needs a memory id");
		retireMemory(store.db, id, "user", now);
		io.stdout.write(`Retired memory ${id}\n`);
		return 0;
	} finally {
		store.close();
	}
}

/** `nexo playbook show <skill> [--all]`, `nexo playbook add <skill> <text…>` (a human item), `nexo playbook retire <skill> <key>`. */
export function playbookCommand(args: string[], io: CliIO, options: CliOptions): number {
	const [sub, skill, ...rest] = args;
	const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { all: { type: "boolean" } } });
	if (sub !== "show" && sub !== "add" && sub !== "retire") throw usageError(sub === undefined ? "nexo playbook needs show, add or retire" : `Unknown playbook subcommand "${sub}"`);
	if (!isSkillName(skill)) throw usageError(`nexo playbook ${sub} needs a skill name`);
	const store = openStore(options);
	try {
		const now = new Date().toISOString();
		if (sub === "show") {
			const artifact = getActiveArtifact(store.db, "playbook", skill);
			const items = listPlaybookItems(store.db, skill, { includeRetired: values.all === true });
			io.stdout.write(`Playbook ${skill}${artifact ? ` · version ${artifact.version} (${artifact.origin})` : " · no version yet"}\n`);
			for (const i of items) {
				io.stdout.write(`  [${i.key}] ${i.source.padEnd(5)} +${i.helpful}/-${i.harmful}  ${oneLine(i.content, 200)}${i.status === "retired" ? " [retired]" : ""}\n`);
			}
			if (items.length === 0) io.stdout.write("  (no items)\n");
			return 0;
		}
		if (sub === "add") {
			const text = positionals.join(" ").trim();
			if (!text) throw usageError("nexo playbook add needs the item text");
			const { item, version } = transaction(store.db, () => {
				const added = addPlaybookItem(store.db, { skill, content: text, source: "human" }, store.redact, now);
				return { item: added, version: publishPlaybook(store.db, skill, "manual", now) };
			});
			io.stdout.write(`Added ${skill}/${item.key}${version ? ` · playbook version ${version.version}` : ""}\n`);
			return 0;
		}
		const [key] = positionals;
		if (!key) throw usageError("nexo playbook retire needs an item key");
		const version = transaction(store.db, () => {
			retirePlaybookItem(store.db, skill, key, "user", now);
			return publishPlaybook(store.db, skill, "manual", now);
		});
		io.stdout.write(`Retired ${skill}/${key}${version ? ` · playbook version ${version.version}` : ""}\n`);
		return 0;
	} finally {
		store.close();
	}
}
