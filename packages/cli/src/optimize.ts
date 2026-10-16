import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type ClimbEvent, type NexoConfig, type OptimizeEvent, startClimb, startOptimization } from "@nexo/core";
import type { OptimReport } from "@nexo/optimize";
import {
	addEvalCase,
	approveOptimRun,
	checkPromotion,
	type Db,
	getArtifact,
	getOptimRun,
	isPidAlive,
	listEvalCases,
	listOptimRuns,
	type OptimRunRow,
	parseOptimTarget,
	recoverCrashedOptimRuns,
	rollbackOptimRun,
} from "@nexo/store";
import { NexoError } from "@nexo/telemetry";
import { nonInteractivePrompter } from "@nexo/tools";
import { escapeControl } from "@nexo/tui";
import { type CliIO, type CliOptions, EXIT_SIGINT, usageError } from "./common.ts";
import { openStore } from "./learn.ts";
import { createRuntime } from "./runtime.ts";

const usd = (v: number) => `$${v.toFixed(4)}`;
const q = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toFixed(3));

function versionOf(db: Db, id: string | null): string {
	if (!id) return "–";
	const a = getArtifact(db, id);
	return a ? `v${a.version} (${a.status})` : id;
}

/** One line per optimization in `nexo optimize list`. */
export function optimRunLine(run: OptimRunRow): string {
	const holdout = run.holdoutBefore === null ? "" : ` · holdout ${q(run.holdoutBefore)} → ${q(run.holdoutAfter)}`;
	const promotion = run.promotion ? ` · ${run.promotion.replace("_", " ")}` : "";
	const climb = run.mode === "climb" ? ` · ${run.climbOutcome ?? "no outcome"}` : "";
	const target = `${run.mode === "climb" ? "climb " : ""}${escapeControl(run.target)}`;
	return `${run.id}  ${target.padEnd(22)} ${run.status.padEnd(9)} ${(run.stopReason ?? "").padEnd(15)} ${usd(run.spentUsd)} of $${run.budgetUsd.toFixed(2)} · ${run.rollouts} rollouts${holdout}${climb}${promotion}`;
}

/** The report summary printed by `nexo optimize` and `nexo optimize show`. */
export function reportLines(db: Db, run: OptimRunRow, report: OptimReport | null, minJudgeKappa: number, options: { diff?: boolean } = {}): string[] {
	const lines = [optimRunLine(run), `  base ${versionOf(db, run.baseArtifactId)} · best ${versionOf(db, run.bestArtifactId)}`];
	if (run.error) lines.push(`  error [${run.error.code}] ${escapeControl(run.error.message)}`);
	if (!report) return lines;
	if (report.climb) {
		const c = report.climb;
		lines.push(`  climb on case ${c.caseId} (${c.guardIds.length} guard${c.guardIds.length === 1 ? "" : "s"}) · ${c.outcome}`);
		if (c.critique) lines.push(`  critique: ${escapeControl(c.critique)}`);
		for (const p of c.comparisons) lines.push(`    ${escapeControl(p.label).padEnd(20)} ${p.winner === "tie" ? "tie" : `${p.winner} preferred`}`);
	}
	const h = report.holdout;
	lines.push(`  holdout (${h.cases.length} cases): quality ${q(h.before.quality)} → ${q(h.after.quality)}, cost ${usd(h.before.costUsd)} → ${usd(h.after.costUsd)} per case; ${h.wins} wins, ${h.losses} losses, ${h.ties} ties`);
	for (const c of h.cases) lines.push(`    ${c.outcome.padEnd(4)} ${q(c.before.quality)} → ${q(c.after.quality)}  ${escapeControl(c.input.replace(/\s+/g, " ").slice(0, 80))}`);
	if (!report.climb) lines.push(`  ${report.iterations} iterations, ${report.lineage.length - 1} candidates, ${report.merges} merges${report.mergeNote ? ` (${escapeControl(report.mergeNote)})` : ""}`);
	const e = report.evidence;
	lines.push(
		e.humanScored
			? "  evidence: human verdicts"
			: `  evidence: ${e.judgeOnly ? "judge only" : "includes deterministic scorers"} · judge ${escapeControl(e.judgeKey ?? "none")} κ ${e.kappa === null ? "–" : e.kappa.toFixed(2)} (min ${minJudgeKappa})`,
	);
	const check = checkPromotion(db, run, minJudgeKappa);
	if (run.promotion === "approved") lines.push(`  approved; undo with \`nexo optimize rollback ${run.id}\``);
	else if (check.allowed) lines.push(`  approve with \`nexo optimize approve ${run.id}\``);
	else lines.push(`  cannot approve: ${escapeControl(check.error?.message ?? "")}`);
	if (options.diff) {
		lines.push("  diff (base → best):");
		for (const d of report.diff) lines.push(`    ${d.op === "add" ? "+" : d.op === "del" ? "-" : " "} ${escapeControl(d.text)}`);
	}
	return lines;
}

function readReport(run: OptimRunRow): OptimReport | null {
	if (!run.reportRef) return null;
	const file = join(run.dirPath, run.reportRef);
	if (!existsSync(file)) return null;
	return JSON.parse(readFileSync(file, "utf8")) as OptimReport;
}

function requireRun(db: Db, id: string | undefined): OptimRunRow {
	if (!id) throw usageError("Pass an optimization id");
	const run = getOptimRun(db, id);
	if (!run) throw new NexoError({ code: "NOT_FOUND", message: `Optimization ${id} does not exist`, hint: "List optimizations with `nexo optimize list`" });
	return run;
}

/** A progress line for an optimization event, or null. Model-influenced text is control-escaped. */
export function optimizeEventLine(event: OptimizeEvent): string | null {
	switch (event.type) {
		case "start":
			return `optimizing ${escapeControl(event.target)} (${event.optimRunId}) · $${event.budgetUsd.toFixed(2)} · cases: ${event.cases.feedback} feedback, ${event.cases.pareto} pareto, ${event.cases.holdout} holdout`;
		case "phase":
			return `· ${event.phase === "baseline" ? "evaluating the current version" : event.phase === "loop" ? "searching" : "evaluating the best candidate on the holdout split"}`;
		case "iteration":
			return `  iteration ${event.iteration}: ${event.component}`;
		case "rejected":
			return `    rejected: ${escapeControl(event.reason)}`;
		case "minibatch":
			return `    minibatch ${q(event.parentQuality)} → ${q(event.childQuality)} ${event.accepted ? "✓ accepted" : "✗ not better"}`;
		case "pareto":
			return `    pareto mean ${q(event.meanQuality)} at ${usd(event.meanCostUsd)}${event.newMember ? " · new Pareto member" : ""}`;
		case "merge":
			return `    merge of ${event.parents.join(" and ")} ${event.accepted ? "kept" : "dropped"}`;
		case "reflection":
			return event.problem ? `    reflection unusable: ${escapeControl(event.problem)}` : null;
		default:
			return null;
	}
}

function positiveNumber(flag: string, raw: string | undefined, integer: boolean): number | undefined {
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) throw usageError(`${flag} must be a positive ${integer ? "integer" : "number"}`);
	return value;
}

/** The notice printed before a foreground optimization: rollouts replay past instructions with the user's allowed tools and MCP servers, side effects included. Null when there are none. */
function rolloutNotice(config: NexoConfig): string | null {
	const allowed = Object.entries(config.tools.policy).filter(([, action]) => action === "allow").map(([tool]) => escapeControl(tool));
	const servers = Object.keys(config.mcp.servers).map((name) => escapeControl(name));
	if (allowed.length === 0 && servers.length === 0) return null;
	const parts = [allowed.length > 0 ? `tools set to allow (${allowed.join(", ")})` : null, servers.length > 0 ? `configured MCP servers (${servers.join(", ")})` : null].filter((p) => p !== null);
	return `notice: rollouts replay past instructions under your tool policy, so ${parts.join(" and ")} run once per rollout and their side effects happen each time`;
}

/** `nexo optimize --target …`: one optimization in the foreground. */
async function runOptimize(args: string[], io: CliIO, options: CliOptions): Promise<number> {
	const { values } = parseArgs({
		args,
		options: { target: { type: "string" }, "budget-usd": { type: "string" }, "max-rollouts": { type: "string" }, merge: { type: "boolean" }, seed: { type: "string" } },
	});
	if (!values.target) throw usageError("nexo optimize needs --target skill:<name>|system_prompt|planner_prompt|judge_rubric");
	const seed = values.seed === undefined ? undefined : Number(values.seed);
	if (seed !== undefined && !(Number.isInteger(seed) && seed >= 0)) throw usageError("--seed must be a non-negative integer");
	const runtime = createRuntime({ env: options.env ?? process.env, cwd: options.cwd ?? process.cwd(), prompter: nonInteractivePrompter, models: options.models });
	try {
		const notice = rolloutNotice(runtime.config);
		if (notice) io.stderr.write(`${notice}\n`);
		const { run, report } = await startOptimization(runtime.engine.env, {
			target: values.target,
			budgetUsd: positiveNumber("--budget-usd", values["budget-usd"], false),
			maxRollouts: positiveNumber("--max-rollouts", values["max-rollouts"], true),
			merge: values.merge ?? false,
			...(seed !== undefined ? { seed } : {}),
			signal: options.signal,
			onEvent: (event) => {
				const line = optimizeEventLine(event);
				if (line) io.stderr.write(`${line}\n`);
			},
		});
		for (const line of reportLines(runtime.db, run, report, runtime.config.optimize.minJudgeKappa)) io.stdout.write(`${line}\n`);
		return run.status === "aborted" ? EXIT_SIGINT : 0;
	} finally {
		await runtime.mcp?.close();
		runtime.db.close();
	}
}

/** A progress line for a climb event, or null. */
export function climbEventLine(event: ClimbEvent): string | null {
	if (event.type === "start") return `climbing ${escapeControl(event.target)} (${event.optimRunId}) on case ${event.caseId} with ${event.guardIds.length} guard${event.guardIds.length === 1 ? "" : "s"} · $${event.budgetUsd.toFixed(2)}`;
	if (event.type === "step") return `  ${event.step}: ${escapeControl(event.detail)}`;
	return event.type === "reflection" ? optimizeEventLine(event) : null;
}

/** `nexo optimize climb --target … [--case] [--guards] [--budget-usd] [--seed]`: one climb in the foreground. */
async function runClimb(args: string[], io: CliIO, options: CliOptions): Promise<number> {
	const { values } = parseArgs({ args, options: { target: { type: "string" }, case: { type: "string" }, guards: { type: "string" }, "budget-usd": { type: "string" }, seed: { type: "string" } } });
	if (!values.target) throw usageError("nexo optimize climb needs --target skill:<name>|system_prompt|planner_prompt");
	const guards = values.guards === undefined ? undefined : Number(values.guards);
	if (guards !== undefined && !(Number.isInteger(guards) && guards >= 0 && guards <= 10)) throw usageError("--guards must be an integer from 0 to 10");
	const seed = values.seed === undefined ? undefined : Number(values.seed);
	if (seed !== undefined && !(Number.isInteger(seed) && seed >= 0)) throw usageError("--seed must be a non-negative integer");
	const budgetUsd = positiveNumber("--budget-usd", values["budget-usd"], false);
	const runtime = createRuntime({ env: options.env ?? process.env, cwd: options.cwd ?? process.cwd(), prompter: nonInteractivePrompter, models: options.models });
	try {
		const notice = rolloutNotice(runtime.config);
		if (notice) io.stderr.write(`${notice}\n`);
		const { run, report } = await startClimb(runtime.engine.env, {
			target: values.target,
			...(values.case ? { caseId: values.case } : {}),
			...(guards !== undefined ? { guards } : {}),
			...(budgetUsd !== undefined ? { budgetUsd } : {}),
			...(seed !== undefined ? { seed } : {}),
			signal: options.signal,
			onEvent: (event) => {
				const line = climbEventLine(event);
				if (line) io.stderr.write(`${line}\n`);
			},
		});
		for (const line of reportLines(runtime.db, run, report, runtime.config.optimize.minJudgeKappa)) io.stdout.write(`${line}\n`);
		return run.status === "aborted" ? EXIT_SIGINT : 0;
	} finally {
		await runtime.mcp?.close();
		runtime.db.close();
	}
}

/** `nexo optimize …`: run one, or `climb …`, or `list`, `show <id> [--diff]`, `approve <id>`, `rollback <id>`. */
export async function optimizeCommand(args: string[], io: CliIO, options: CliOptions): Promise<number> {
	const [sub, ...rest] = args;
	if (sub === undefined || sub.startsWith("-")) return runOptimize(args, io, options);
	if (sub === "climb") return runClimb(rest, io, options);
	const store = openStore(options);
	try {
		recoverCrashedOptimRuns(store.db, isPidAlive, new Date().toISOString());
		const now = new Date().toISOString();
		switch (sub) {
			case "list": {
				const runs = listOptimRuns(store.db);
				if (runs.length === 0) io.stdout.write("No optimizations yet. Start one with `nexo optimize --target <target>`.\n");
				for (const run of runs) io.stdout.write(`${optimRunLine(run)}\n`);
				return 0;
			}
			case "show": {
				const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { diff: { type: "boolean" } } });
				const run = requireRun(store.db, positionals[0]);
				for (const line of reportLines(store.db, run, readReport(run), store.config.optimize.minJudgeKappa, { diff: values.diff ?? false })) io.stdout.write(`${line}\n`);
				return 0;
			}
			case "approve": {
				const run = requireRun(store.db, rest[0]);
				const { promoted, replaced } = approveOptimRun(store.db, run.id, { minJudgeKappa: store.config.optimize.minJudgeKappa, nowIso: now });
				io.stdout.write(`Promoted ${promoted.kind} ${promoted.name} v${promoted.version}${replaced ? ` (v${replaced.version} retired)` : ""}\n`);
				return 0;
			}
			case "rollback": {
				const run = requireRun(store.db, rest[0]);
				const { active, retired } = rollbackOptimRun(store.db, run.id, now);
				io.stdout.write(`Rolled back ${retired.kind} ${retired.name}: v${retired.version} retired${active ? `, v${active.version} active again` : ""}\n`);
				return 0;
			}
			default:
				throw usageError(`Unknown optimize subcommand "${sub}"`);
		}
	} finally {
		store.close();
	}
}

/** `nexo eval add --target <t> --input <text> [--skill] [--expected] [--feedback]`: a hand-written eval case. */
export function evalAddCommand(args: string[], io: CliIO, options: CliOptions): number {
	const { values } = parseArgs({ args, options: { target: { type: "string" }, input: { type: "string" }, skill: { type: "string" }, expected: { type: "string" }, feedback: { type: "string" } } });
	if (!values.target || values.input === undefined) throw usageError("nexo eval add needs --target and --input");
	const store = openStore(options);
	try {
		const row = addEvalCase(store.db, { target: values.target, input: values.input, skill: values.skill ?? null, expected: values.expected ?? null, referenceFeedback: values.feedback ?? null }, store.redact, new Date().toISOString());
		io.stdout.write(`Added eval case ${row.id} for ${row.target} (${row.split} split)\n`);
		return 0;
	} finally {
		store.close();
	}
}

/** `nexo eval list --target <t>`: the target's eval cases with their split and origin. */
export function evalListCommand(args: string[], io: CliIO, options: CliOptions): number {
	const { values } = parseArgs({ args, options: { target: { type: "string" } } });
	if (!values.target) throw usageError("nexo eval list needs --target");
	const target = parseOptimTarget(values.target);
	const store = openStore(options);
	try {
		const cases = listEvalCases(store.db, target.key);
		io.stdout.write(`${cases.length} eval case${cases.length === 1 ? "" : "s"} for ${target.key}\n`);
		for (const c of cases) {
			io.stdout.write(`  ${c.id} ${c.split.padEnd(8)} ${c.origin.padEnd(6)} ${c.status.padEnd(9)} ${escapeControl(c.input.replace(/\s+/g, " ").slice(0, 80))}${c.referenceFeedback ? ` — "${escapeControl(c.referenceFeedback.slice(0, 60))}"` : ""}\n`);
		}
		return 0;
	} finally {
		store.close();
	}
}
