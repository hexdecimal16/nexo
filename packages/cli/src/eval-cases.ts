import { parseArgs } from "node:util";
import { mineEvalCases } from "@nexo/core";
import { parseOptimTarget, reviewProposedCase, revertGolden } from "@nexo/store";
import { nonInteractivePrompter } from "@nexo/tools";
import { escapeControl } from "@nexo/tui";
import { type CliIO, type CliOptions, usageError } from "./common.ts";
import { openStore } from "./learn.ts";
import { createRuntime } from "./runtime.ts";

const firstLine = (s: string) => escapeControl(s.split("\n")[0]?.slice(0, 80) ?? "");

/** `nexo eval mine --target <t> [--days <n>]`: one mining pass; prints the cases it proposed and the ones waiting. */
export async function evalMineCommand(args: string[], io: CliIO, options: CliOptions): Promise<number> {
	const { values } = parseArgs({ args, options: { target: { type: "string" }, days: { type: "string" } } });
	if (!values.target) throw usageError("nexo eval mine needs --target");
	const days = values.days === undefined ? undefined : Number(values.days);
	if (days !== undefined && !(Number.isInteger(days) && days > 0)) throw usageError("--days must be a positive integer");
	const target = parseOptimTarget(values.target);
	const runtime = createRuntime({ env: options.env ?? process.env, cwd: options.cwd ?? process.cwd(), prompter: nonInteractivePrompter, models: options.models });
	try {
		const result = await mineEvalCases(runtime.engine.env, target, days === undefined ? {} : { days });
		io.stdout.write(`Considered ${result.considered} unreviewed runs of ${target.key} (${result.measure}); added ${result.added.length}${result.fallbackReason ? ` — embeddings failed: ${escapeControl(result.fallbackReason)}` : ""}\n`);
		for (const c of result.waiting) io.stdout.write(`  proposed ${c.id} (${c.minedFrom?.length ?? 0} runs) ${firstLine(c.input)}\n`);
		if (result.waiting.length > 0) io.stdout.write("Accept with `nexo eval accept <id> [--expected <text>]`, or `nexo eval dismiss <id>`\n");
		return 0;
	} finally {
		await runtime.mcp?.close();
		runtime.db.close();
	}
}

/** `nexo eval accept <id> [--expected <text>]` and `nexo eval dismiss <id>`. */
export function evalReviewCommand(decision: "accept" | "dismiss", args: string[], io: CliIO, options: CliOptions): number {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: decision === "accept" ? { expected: { type: "string" } } : {} });
	const id = positionals[0];
	if (!id) throw usageError(`nexo eval ${decision} needs a case id`);
	const store = openStore(options);
	try {
		const expected = (values as { expected?: string }).expected;
		const row = reviewProposedCase(store.db, id, decision, { expected: expected ?? null, redact: store.redact, nowIso: new Date().toISOString() });
		io.stdout.write(`${decision === "accept" ? "Accepted" : "Dismissed"} eval case ${row.id}${row.expected !== null && decision === "accept" ? " with a golden" : ""}\n`);
		return 0;
	} finally {
		store.close();
	}
}

/** `nexo eval golden revert <id>`: back to the last human-approved golden. */
export function evalGoldenCommand(args: string[], io: CliIO, options: CliOptions): number {
	const [sub, id] = args;
	if (sub !== "revert" || !id) throw usageError("Usage: nexo eval golden revert <case-id>");
	const store = openStore(options);
	try {
		const row = revertGolden(store.db, id, new Date().toISOString());
		io.stdout.write(row.expected === null ? `Eval case ${row.id} has no golden now\n` : `Eval case ${row.id} is back on its ${row.goldenSource} golden\n`);
		return 0;
	} finally {
		store.close();
	}
}
