import { describe, expect, it } from "vitest";
import { createRedactor } from "@nexo/telemetry";
import { addEvalCase, getEvalCase, listGoldens, MAX_EVAL_INPUT_CHARS, openDb, raiseGolden, revertGolden, reviewProposedCase } from "../src/index.ts";

const NOW = "2026-10-16T00:00:00.000Z";
const redact = createRedactor();

function minedCase(db: ReturnType<typeof openDb>, id = "M1"): void {
	db.prepare("INSERT INTO eval_cases (id, target, source_run_id, input, split, created_at, skill, origin, status, mined_from_json) VALUES (?, 'skill:ci-fix', ?, 'fix ci', 'pareto', ?, 'ci-fix', 'mined', 'proposed', '[\"R1\",\"R2\",\"R3\"]')").run(id, `R-${id}`, NOW);
}

describe("golden history", () => {
	it("records a manual golden, raises it from a climb (clipped and redacted) and reverts to the last human golden", () => {
		const db = openDb(":memory:");
		const c = addEvalCase(db, { target: "skill:ci-fix", input: "fix ci", expected: "human answer" }, redact, NOW);
		expect(listGoldens(db, c.id).map((g) => g.source)).toEqual(["manual"]);
		const long = `sk-ant-api03-${"a".repeat(40)} ${"x".repeat(MAX_EVAL_INPUT_CHARS)}`;
		const raised = raiseGolden(db, { caseId: c.id, expected: long, sourceRunId: "R9", optimRunId: "O1", redact, nowIso: NOW });
		expect(raised.goldenSource).toBe("climb");
		expect(raised.expected?.length).toBe(MAX_EVAL_INPUT_CHARS);
		expect(raised.expected).not.toContain("sk-ant-api03");
		raiseGolden(db, { caseId: c.id, expected: "second raise", sourceRunId: "R10", optimRunId: "O2", redact, nowIso: NOW });
		expect(revertGolden(db, c.id, NOW)).toMatchObject({ expected: "human answer", goldenSource: "manual" });
		expect(listGoldens(db, c.id).map((g) => g.source)).toEqual(["manual", "climb", "climb", "manual"]);
		expect(() => revertGolden(db, c.id, NOW)).toThrow(/not from climb/);
	});

	it("reverts to no golden when no human golden ever existed", () => {
		const db = openDb(":memory:");
		const c = addEvalCase(db, { target: "skill:ci-fix", input: "fix ci" }, redact, NOW);
		raiseGolden(db, { caseId: c.id, expected: "machine", sourceRunId: null, optimRunId: "O1", redact, nowIso: NOW });
		expect(revertGolden(db, c.id, NOW)).toMatchObject({ expected: null, goldenSource: null });
	});

	it("refuses unknown cases", () => {
		const db = openDb(":memory:");
		expect(() => revertGolden(db, "NOPE", NOW)).toThrow(/does not exist/);
		expect(() => raiseGolden(db, { caseId: "NOPE", expected: "x", sourceRunId: null, optimRunId: "O", redact, nowIso: NOW })).toThrow(/does not exist/);
	});
});

describe("reviewProposedCase", () => {
	it("accepts with and without a golden, dismisses, and refuses anything not proposed", () => {
		const db = openDb(":memory:");
		minedCase(db, "M1");
		minedCase(db, "M2");
		minedCase(db, "M3");
		expect(reviewProposedCase(db, "M1", "accept", { redact, nowIso: NOW })).toMatchObject({ status: "active", expected: null, goldenSource: null });
		expect(reviewProposedCase(db, "M2", "accept", { expected: "the answer", redact, nowIso: NOW })).toMatchObject({ status: "active", expected: "the answer", goldenSource: "manual" });
		expect(listGoldens(db, "M2")).toHaveLength(1);
		expect(reviewProposedCase(db, "M3", "dismiss", { redact, nowIso: NOW }).status).toBe("dismissed");
		expect(() => reviewProposedCase(db, "M1", "dismiss", { redact, nowIso: NOW })).toThrow(/is active, not proposed/);
		expect(() => reviewProposedCase(db, "NOPE", "accept", { redact, nowIso: NOW })).toThrow(/does not exist/);
		expect(() => reviewProposedCase(db, "M3", "accept", { expected: "an answer", redact, nowIso: NOW })).toThrow(/dismissed, not proposed/);
		expect(getEvalCase(db, "M3")?.status).toBe("dismissed");
	});

	it("refuses an over-long golden on accept", () => {
		const db = openDb(":memory:");
		minedCase(db, "M1");
		expect(() => reviewProposedCase(db, "M1", "accept", { expected: "y".repeat(MAX_EVAL_INPUT_CHARS + 1), redact, nowIso: NOW })).toThrow(/longer than/);
		expect(getEvalCase(db, "M1")?.status).toBe("proposed");
	});
});
