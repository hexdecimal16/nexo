import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { insertRun, listFeedback, openDb } from "@nexo/store";
import { createRedactor, REDACTED } from "@nexo/telemetry";
import { runRow } from "../../store/test/fixtures.ts";
import { createTtyLineAsker, isInteractiveTerminal, type LineAsker, parseReviewAnswer, promptReview } from "../src/review.ts";

function scripted(answers: (string | null)[]): LineAsker & { asked: string[] } {
	const asked: string[] = [];
	return {
		asked,
		ask: async (q) => {
			asked.push(q);
			return answers.length ? (answers.shift() as string | null) : null;
		},
	};
}

function setup() {
	const db = openDb(":memory:");
	const run = runRow({ status: "succeeded" });
	insertRun(db, run);
	let err = "";
	const io = { stderr: { write: (s: string) => ((err += s), true) } };
	return { db, run, io, err: () => err, redact: createRedactor() };
}

describe("parseReviewAnswer", () => {
	it("accepts short and long forms; empty is skip", () => {
		expect(["d", "DONE", "n", "not done", "s", "", "  "].map(parseReviewAnswer)).toEqual(["done", "done", "not_done", "not_done", "skip", "skip", "skip"]);
		expect(parseReviewAnswer("maybe")).toBeNull();
	});
});

describe("promptReview", () => {
	it("records done without asking for a comment", async () => {
		const s = setup();
		const asker = scripted(["d"]);
		expect(await promptReview({ asker, db: s.db, runId: s.run.id, redact: s.redact, io: s.io })).toBe("done");
		expect(asker.asked).toHaveLength(1);
		expect(listFeedback(s.db, s.run.id).map((f) => f.verdict)).toEqual(["done"]);
	});

	it("records not done with a redacted comment", async () => {
		const s = setup();
		await promptReview({ asker: scripted(["n", "used key sk-ant-abcdefghijklmnopqrstu"]), db: s.db, runId: s.run.id, redact: s.redact, io: s.io });
		expect(listFeedback(s.db, s.run.id)[0]).toMatchObject({ verdict: "not_done", comment: `used key ${REDACTED}` });
	});

	it("leaves the run unreviewed on skip, Ctrl-C and repeated nonsense", async () => {
		for (const answers of [["s"], [null], ["x", "y", "z"]]) {
			const s = setup();
			expect(await promptReview({ asker: scripted(answers), db: s.db, runId: s.run.id, redact: s.redact, io: s.io })).toBe("skip");
			expect(listFeedback(s.db, s.run.id)).toEqual([]);
			expect(s.err()).toContain("review queue");
		}
	});
});

describe("createTtyLineAsker", () => {
	it("returns the typed line, and null when input ends", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		output.resume();
		const asker = createTtyLineAsker(input, output);
		const answer = asker.ask("q? ");
		input.write("d\n");
		expect(await answer).toBe("d");
		const ended = asker.ask("q? ");
		input.end();
		expect(await ended).toBeNull();
	});
});

describe("isInteractiveTerminal", () => {
	it("asks only when stdin, stdout and stderr are all terminals", () => {
		const tty = { isTTY: true };
		expect(isInteractiveTerminal({ stdin: tty, stdout: tty, stderr: tty })).toBe(true);
		expect(isInteractiveTerminal({ stdin: tty, stdout: tty, stderr: {} })).toBe(false);
		expect(isInteractiveTerminal({ stdin: tty, stdout: { isTTY: false }, stderr: tty })).toBe(false);
		expect(isInteractiveTerminal({ stdin: {}, stdout: tty, stderr: tty })).toBe(false);
	});
});
