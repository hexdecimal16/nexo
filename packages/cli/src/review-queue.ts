import { parseArgs } from "node:util";
import { reviewQueue } from "@nexo/store";
import { escapeControl } from "@nexo/tui";
import { type CliIO, type CliOptions, usageError } from "./common.ts";
import { openStore } from "./learn.ts";

/** `nexo review-queue [--limit <n>] [--days <n>]`: recent runs without a verdict, worst first. */
export function reviewQueueCommand(args: string[], io: CliIO, options: CliOptions): number {
	const { values } = parseArgs({ args, options: { limit: { type: "string" }, days: { type: "string" } } });
	const limit = values.limit === undefined ? undefined : Number(values.limit);
	const days = values.days === undefined ? undefined : Number(values.days);
	if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw usageError("--limit must be a positive integer");
	if (days !== undefined && !(Number.isInteger(days) && days > 0)) throw usageError("--days must be a positive integer");
	const store = openStore(options);
	try {
		const items = reviewQueue(store.db, { ...(limit ? { limit } : {}), ...(days ? { days } : {}) });
		if (items.length === 0) io.stdout.write("No unreviewed runs in this period\n");
		for (const i of items) {
			const score = i.score === null ? "–" : i.score.toFixed(2);
			io.stdout.write(`${i.runId}  ${i.failureMode.padEnd(15)} score ${score}  $${i.costUsd.toFixed(4)}  ${escapeControl(i.instruction)}\n`);
		}
		if (items.length > 0) io.stdout.write("Label a run in the UI or with /done and /notdone in a session\n");
		return 0;
	} finally {
		store.close();
	}
}
