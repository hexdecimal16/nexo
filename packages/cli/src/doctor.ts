import { parseArgs } from "node:util";
import { createSettings, type DoctorReport, nexoModels, runDoctor } from "@nexo/core";
import { resolveNexoPaths } from "@nexo/store";
import type { CliIO, CliOptions } from "./common.ts";

const MARK = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;

export function formatDoctor(report: DoctorReport): string {
	const lines: string[] = [];
	for (const check of report.checks) {
		lines.push(`${MARK[check.status]}  ${check.message}`);
		if (check.fix && check.status !== "ok") lines.push(`      fix: ${check.fix}`);
	}
	const failed = report.checks.filter((c) => c.status === "fail").length;
	const warned = report.checks.filter((c) => c.status === "warn").length;
	lines.push("", failed > 0 ? `${failed} check(s) failed, ${warned} warning(s)` : `All required checks passed, ${warned} warning(s)`);
	return `${lines.join("\n")}\n`;
}

/** `nexo doctor [--json]`: read-only setup checks. Exit 0 when nothing failed, 1 otherwise. */
export function doctorCommand(args: string[], io: CliIO, options: CliOptions): number {
	const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const paths = resolveNexoPaths(env);
	const settings = createSettings({ paths, cwd, env, models: options.models ?? nexoModels() });
	const report = runDoctor({ paths, settings, env, cwd });
	io.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctor(report));
	return report.ok ? 0 : 1;
}
