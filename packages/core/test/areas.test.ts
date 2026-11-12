import type { SpanRow } from "@nexo/store";
import { wikiPagesTouched } from "../src/learn/areas.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getRun, RunDir, type ScoreRow } from "@nexo/store";
import { type AreaRegistry, approveArea, assignRun, emptyRegistry, readRegistry, recordUnsorted, writeRegistry } from "../src/learn/areas.ts";
import { RunBudget } from "../src/cost/budget.ts";
import { Recorder } from "../src/engine/recorder.ts";
import { finishedRun, makeEnv, script } from "./learn-helpers.ts";

const software = { id: "software", name: "Software", scope: "Code and tools I build", examples: [], aliases: ["dev"], wikis: ["nexo"], status: "active" as const, createdAt: "2026-11-11" };
const item = (label: string, n: number) => ({ runId: `r${n}`, label, reason: `task ${n}`, at: "2026-11-11T00:00:00.000Z" });

describe("area registry", () => {
	it("proposes a new area only after three unsorted tasks share a label", () => {
		let reg: AreaRegistry = { ...emptyRegistry(), areas: [software] };
		for (const n of [1, 2]) {
			const r = recordUnsorted(reg, item(n === 1 ? "Travel" : "travel", n));
			expect(r.proposed).toBeNull();
			reg = r.registry;
		}
		const third = recordUnsorted(reg, item("travel!", 3));
		expect(third.proposed?.id).toBe("travel");
		expect(third.proposed?.status).toBe("proposed");
		const fourth = recordUnsorted(third.registry, item("travel", 4));
		expect(fourth.proposed).toBeNull();
		expect(fourth.registry.areas.filter((a) => a.id.startsWith("travel"))).toHaveLength(1);
	});

	it("never proposes a label an existing area covers by alias", () => {
		let reg: AreaRegistry = { ...emptyRegistry(), areas: [software] };
		for (const n of [1, 2, 3, 4]) reg = recordUnsorted(reg, item("Dev", n)).registry;
		expect(reg.areas).toHaveLength(1);
	});

	it("activates a proposed area only through approveArea", () => {
		const reg: AreaRegistry = { ...emptyRegistry(), areas: [software, { ...software, id: "travel", name: "Travel", status: "proposed" }] };
		expect(approveArea(reg, "travel").areas.find((a) => a.id === "travel")?.status).toBe("active");
		expect(() => approveArea(reg, "software")).toThrow();
		expect(() => approveArea(reg, "missing")).toThrow();
	});
});

async function setup(reply: object) {
	const baseEnv = makeEnv();
	const wikisDir = mkdtempSync(join(tmpdir(), "nexo-areas-"));
	mkdirSync(join(wikisDir, "nexo"));
	baseEnv.deps.paths = { ...baseEnv.deps.paths, wikis: wikisDir };
	writeRegistry(wikisDir, { ...emptyRegistry(), areas: [software] });
	script(baseEnv, ["Fixed the nexo build: the failing import in the tools package now resolves and the tests pass.", JSON.stringify(reply)]);
	const { result, learnEnv } = await finishedRun(baseEnv, { instruction: "Fix the nexo build" });
	const run = getRun(baseEnv.deps.db, result.trajectoryId as string)!;
	const deps = {
		env: learnEnv,
		recorder: new Recorder({ db: baseEnv.deps.db, runDir: new RunDir(run.dirPath, run.id, baseEnv.deps.redact), runId: run.id, now: learnEnv.now, redact: baseEnv.deps.redact }),
		parentSpanId: "span-1",
		budget: new RunBudget(1),
		charge: () => {},
		signal: new AbortController().signal,
	};
	return { wikisDir, deps, run, output: result.output as string };
}

describe("assignRun", () => {
	it("files a verified run into an approved area with its feed line and decisions", async () => {
		const { wikisDir, deps, run, output } = await setup({ areaId: "software", wiki: "nexo", feed: "Fixed the nexo build", decisions: [{ choice: "Keep markdown readers", reason: "less breakage" }] });
		const res = await assignRun(deps, { run, output, spans: [], scores: [{ round: 0, value: 0.9 } as ScoreRow] });
		expect(res).toMatchObject({ areaId: "software", feed: true, decisions: 1, verified: true });
		const feed = JSON.parse(readFileSync(join(wikisDir, "feed.jsonl"), "utf8").trim());
		expect(feed).toMatchObject({ areaId: "software", wiki: "nexo", text: "Fixed the nexo build", verified: true });
		expect(readFileSync(join(wikisDir, "decisions.jsonl"), "utf8")).toContain("Keep markdown readers");
	});

	it("queues an invented area as unsorted and files no decisions from an unscored run", async () => {
		const { wikisDir, deps, run, output } = await setup({ areaId: "travel", feed: "Planned a trip", decisions: [{ choice: "Go in May", reason: "weather" }] });
		const res = await assignRun(deps, { run, output, spans: [], scores: [] });
		expect(res).toMatchObject({ areaId: null, feed: true, decisions: 0, verified: false });
		expect(readRegistry(wikisDir).unsorted.map((u) => u.label)).toEqual(["travel"]);
		expect(readRegistry(wikisDir).areas.map((a) => a.id)).toEqual(["software"]);
		expect(existsSync(join(wikisDir, "decisions.jsonl"))).toBe(false);
	});
});

describe("wikiPagesTouched", () => {
	it("keeps only successful write and edit calls on HTML pages inside the wikis dir", () => {
		const span = (name: string, path: string, status = "ok") => ({ kind: "tool_call", name, status, attrs: { args: { path } } }) as unknown as SpanRow;
		const spans = [span("write", "/w/nexo/concepts/a.html"), span("edit", "/w/nexo/log.md"), span("write", "/other/x.html"), span("read", "/w/ai/b.html"), span("write", "/w/ai/c.html", "error")];
		expect(wikiPagesTouched(spans, "/w")).toEqual(["nexo/concepts/a.html"]);
	});
});
