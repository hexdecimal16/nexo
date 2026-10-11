import { parseArgs } from "node:util";
import { calibrateJudge, loadConfig } from "@nexo/core";
import { ensureNexoDirs, openDb, resolveNexoPaths } from "@nexo/store";
import { escapeControl } from "@nexo/tui";
import { type CliIO, type CliOptions, usageError } from "./common.ts";

function pct(value: number | null): string {
	return value === null ? "–" : `${(value * 100).toFixed(1)}%`;
}

/** `nexo eval judge [--judge <provider/id[+provider/id…]>]`: judge-vs-human agreement, stored for the UI. */
export function evalCommand(args: string[], io: CliIO, options: CliOptions): number {
	const [sub, ...rest] = args;
	if (sub !== "judge") throw usageError(sub === undefined ? "nexo eval needs a subcommand" : `Unknown eval subcommand "${sub}"`);
	const { values } = parseArgs({ args: rest, options: { judge: { type: "string" } } });
	const env = options.env ?? process.env;
	const paths = resolveNexoPaths(env);
	ensureNexoDirs(paths);
	const { config } = loadConfig({ paths, cwd: options.cwd ?? process.cwd() });
	const db = openDb(paths.db);
	try {
		const report = calibrateJudge(db, config, { judgeKey: values.judge, nowIso: new Date().toISOString() });
		for (const warning of report.warnings) io.stderr.write(`warning: ${escapeControl(warning)}\n`);
		const m = report.matrix;
		const cal = report.calibration;
		io.stdout.write(`Judge ${escapeControl(report.judgeKey)} vs human verdicts\n`);
		if (!cal) {
			io.stdout.write("  No run has both a score from this judge and a human verdict yet.\n  Review judged runs (the web UI review queue, or /done and /notdone in a session), then run this again.\n");
			return 0;
		}
		io.stdout.write(`  cases        ${cal.cases}\n`);
		io.stdout.write(`  agreement    ${cal.agreements} (${pct(cal.accuracy)})\n`);
		io.stdout.write(`  Cohen's κ    ${cal.kappa === null ? "– (every verdict is in one class)" : cal.kappa.toFixed(3)}\n`);
		io.stdout.write(`                 human done   human not done\n`);
		io.stdout.write(`  judge pass     ${String(m.bothPass).padStart(10)}   ${String(m.judgePassHumanFail).padStart(14)}\n`);
		io.stdout.write(`  judge fail     ${String(m.judgeFailHumanPass).padStart(10)}   ${String(m.bothFail).padStart(14)}\n`);
		io.stdout.write(`  disagreements ${report.disagreements.length} (stored as judge_rubric eval cases)\n`);
		for (const d of report.disagreements.slice(0, 10)) {
			const first = escapeControl(d.instruction.split("\n")[0]?.slice(0, 60) ?? "");
			io.stdout.write(`  - ${d.runId} judge ${d.judgePassed ? "pass" : "fail"}, human ${d.verdict === "done" ? "done" : "not done"}: ${first}${d.comment ? ` — "${escapeControl(d.comment.slice(0, 80))}"` : ""}\n`);
		}
		io.stdout.write(`Saved calibration ${cal.id}\n`);
		return 0;
	} finally {
		db.close();
	}
}
