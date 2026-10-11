import { describe, expect, it } from "vitest";
import type { CostResponse, RunDetailResponse, RunSummary, Span, SpanNode } from "../public/lib/api-types.ts";
import { renderError, sessionLink, statusBadge } from "../public/lib/common-view.ts";
import { costQuery, renderCostTable, renderDimensionOptions } from "../public/lib/cost-view.ts";
import { filePath, parseUnifiedDiff, renderFile, renderListing } from "../public/lib/files-view.ts";
import { durationMs, formatDuration, formatUsd } from "../public/lib/format.ts";
import { esc, html } from "../public/lib/html.ts";
import { createPoller, MAX_POLL_BACKOFF_MS, POLL_MS, pollDelay } from "../public/lib/poller.ts";
import { renderChildren, renderFeedbackForm, renderRunHeader, shouldPoll } from "../public/lib/run-view.ts";
import { renderRunRows, renderSessionFilter, renderStatusOptions, runsQuery } from "../public/lib/runs-view.ts";
import { findSpan, renderSpanDetail, renderSpanTree } from "../public/lib/span-view.ts";
import { renderTimeline, timelineRows } from "../public/lib/timeline.ts";

const XSS = `<img src=x onerror="alert(1)"><script>alert('x')</script>\``;
const NOW = Date.parse("2026-10-10T10:00:20.000Z");

/** Markup is safe when no hostile tag or attribute survives: only escaped forms of the payload may appear. */
function expectInert(markup: string): void {
	expect(markup).not.toContain("<script");
	expect(markup).not.toContain("<img");
	expect(markup).not.toContain(`onerror="`);
	expect(markup).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
}

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
	return {
		id: "01J00000000000000000000001",
		parentRunId: null,
		rootRunId: "01J00000000000000000000001",
		instruction: XSS,
		skill: XSS,
		status: "succeeded",
		modelFinal: XSS,
		tierFinal: "s1",
		startedAt: "2026-10-10T10:00:00.000Z",
		endedAt: "2026-10-10T10:00:10.000Z",
		costUsd: 0.0123,
		costUnknown: false,
		tokensIn: 1,
		tokensOut: 2,
		childCount: 0,
		verdict: null,
		error: null,
		sessionId: null,
		turnIndex: null,
		sessionTitle: null,
		score: null,
		...overrides,
	};
}

function span(overrides: Partial<Span> = {}): Span {
	return {
		id: "s1",
		runId: "01J00000000000000000000001",
		parentSpanId: null,
		kind: "llm_call",
		name: XSS,
		status: "ok",
		startedAt: "2026-10-10T10:00:00.000Z",
		endedAt: "2026-10-10T10:00:01.000Z",
		queuedMs: null,
		model: XSS,
		provider: "faux",
		tier: "s1",
		effort: "low",
		modelSource: "skill",
		tokensIn: 10,
		tokensOut: 5,
		cacheRead: 0,
		cacheWrite: 0,
		costUsd: 0.001,
		costUnknown: false,
		payloadRef: null,
		attrs: {},
		...overrides,
	};
}

const node = (s: Span, children: SpanNode[] = []): SpanNode => ({ span: s, attrsTruncated: false, children });

describe("html", () => {
	it("escapes every interpolation, including quotes and backticks, and keeps nested html", () => {
		expect(esc(`<a href="x" title='y'>\``)).toBe("&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&#96;");
		const inner = html`<b>${"<i>"}</b>`;
		expect(html`<p title="${'" onmouseover="x'}">${inner}${[1, null, false, undefined, "<u>"]}</p>`.value).toBe(
			`<p title="&quot; onmouseover=&quot;x"><b>&lt;i&gt;</b>1&lt;u&gt;</p>`,
		);
	});
});

describe("format", () => {
	it("formats money, unknown costs and durations without locale", () => {
		expect(formatUsd(0.1)).toBe("$0.1000");
		expect(formatUsd(0.1, true)).toBe("$0.1000 + unpriced");
		expect(formatUsd(Number.NaN)).toBe("$0.0000");
		expect([formatDuration(null), formatDuration(850), formatDuration(4200), formatDuration(185_000)]).toEqual(["–", "850 ms", "4.2 s", "3m 05s"]);
		expect(durationMs("2026-10-10T10:00:00.000Z", null, NOW)).toBe(20_000);
	});
});

describe("runs view", () => {
	it("escapes agent text in run rows and links by encoded id", () => {
		const markup = renderRunRows([summary(), summary({ id: "a&b", costUnknown: true, verdict: "not_done", childCount: 2 })], NOW).value;
		expectInert(markup);
		expect(markup).toContain(`href="/run.html?id=a%26b"`);
		expect(markup).toContain("+ unpriced");
		expect(markup).toContain("2 subagents");
	});

	it("builds list queries; the review tab asks for reviewed=false", () => {
		expect(runsQuery({ tab: "review", status: "", skill: " ", since: "", session: "", scored: "" }, null)).toBe("/api/runs?reviewed=false&limit=50");
		expect(runsQuery({ tab: "all", status: "failed", skill: "a b", since: "2026-10-01", session: "", scored: "" }, "c&d", 10)).toBe(
			"/api/runs?status=failed&skill=a+b&since=2026-10-01&limit=10&cursor=c%26d",
		);
		expect(runsQuery({ tab: "all", status: "", skill: "", since: "", session: "s&1", scored: "" }, null)).toBe("/api/runs?session=s%261&limit=50");
		expect(runsQuery({ tab: "all", status: "", skill: "", since: "", session: "", scored: "false" }, null)).toBe("/api/runs?scored=false&limit=50");
	});

	it("shows the session filter with an escaped title and a link that clears it", () => {
		const markup = renderSessionFilter("s&1", XSS).value;
		expectInert(markup);
		expect(markup).toContain("s&amp;1");
		expect(markup).toContain(`href="/"`);
		expect(renderSessionFilter("", null).value).toBe("");
		expect(sessionLink("a b")).toBe("/?session=a%20b");
	});

	it("builds the status filter options from /api/meta", () => {
		expect(renderStatusOptions(["running", "budget_exceeded"], "budget_exceeded").value).toBe(
			`<option value="">any</option><option value="running">running</option><option value="budget_exceeded" selected>budget exceeded</option>`,
		);
	});
});

describe("run view", () => {
	const detail = (overrides: Partial<RunDetailResponse> = {}): RunDetailResponse => ({
		run: summary({ error: { code: "TOOL_DENIED", message: XSS, retryable: false, hint: XSS } }),
		runJson: {
			id: "01J00000000000000000000001", instruction: XSS, skill: null, status: "succeeded",
			model: { provider: "faux", id: XSS, effort: "low", source: "skill", role: "s1" },
			startedAt: "2026-10-10T10:00:00.000Z", endedAt: null, costUsd: 0, costUnknown: false, tokensIn: 0, tokensOut: 0,
			output: XSS, error: null, workspace: "/w",
		},
		dirMissing: false,
		children: [],
		feedback: [],
		childFeedback: {},
		scores: [],
		escalations: [],
		judgeDisagrees: false,
		...overrides,
	});

	it("escapes instruction, output, model and error text and shows model source", () => {
		const markup = renderRunHeader(detail(), NOW).value;
		expectInert(markup);
		expect(markup).toContain("effort low · source skill");
	});

	it("links a session turn to its session's runs", () => {
		const markup = renderRunHeader(detail({ run: summary({ sessionId: "s1", turnIndex: 3, sessionTitle: XSS }) }), NOW).value;
		expectInert(markup);
		expect(markup).toContain(`href="/?session=s1"`);
		expect(markup).toContain("· turn 3");
		expect(renderRunHeader(detail(), NOW).value).not.toContain("?session=");
	});

	it("warns about a deleted directory and unknown cost", () => {
		const markup = renderRunHeader(detail({ dirMissing: true, run: summary({ costUnknown: true }) }), NOW).value;
		expect(markup).toContain("Run directory missing");
		expect(markup).toContain("have no price");
	});

	it("renders a feedback form for finished runs only and escapes the previous comment", () => {
		const form = renderFeedbackForm(summary(), { id: "f", runId: "r", verdict: "not_done", comment: XSS, createdAt: "2026-10-10T11:00:00.000Z" }).value;
		expect(form).toContain(`data-feedback-run="01J00000000000000000000001"`);
		expect(form).toContain(`value="not_done"`);
		expectInert(form);
		expect(renderFeedbackForm(summary({ status: "running" }), undefined).value).not.toContain("<form");
		expect(shouldPoll("running")).toBe(true);
		expect(shouldPoll("failed")).toBe(false);
	});

	it("replaces every form with the read-only reason when the UI refuses writes", () => {
		const readOnly = { message: XSS, hint: "Fix ~/.nexo/config.json" };
		const markup = renderFeedbackForm(summary(), undefined, readOnly).value;
		expect(markup).not.toContain("<form");
		expect(markup).toContain("Verdicts are disabled");
		expectInert(markup);
		expect(renderChildren([summary({ id: "c1" })], NOW, readOnly).value).not.toContain("data-feedback-run");
	});

	it("shows each subagent's latest verdict line with its comment", () => {
		const latest = { id: "f", runId: "c1", verdict: "not_done" as const, comment: XSS, createdAt: "2026-10-10T11:00:00.000Z" };
		const markup = renderChildren([summary({ id: "c1" }), summary({ id: "c2" })], NOW, null, { c1: latest }).value;
		expect(markup.match(/Latest verdict:/g)).toHaveLength(1);
		expectInert(markup);
	});

	it("gives each subagent run its own form", () => {
		const markup = renderChildren([summary({ id: "c1" }), summary({ id: "c2", status: "running" })], NOW).value;
		expect(markup.match(/data-feedback-run=/g)).toHaveLength(1);
		expectInert(markup);
	});
});

describe("span views", () => {
	const tool = span({ id: "t", kind: "tool_call", name: "bash", parentSpanId: "s1", model: null, attrs: { args: { command: XSS }, result: XSS } });
	const llm = span({ attrs: { content: [{ type: "text", text: XSS }, { type: "thinking", thinking: XSS }, { type: "toolCall", name: XSS, arguments: { x: XSS } }] } });

	it("renders a collapsible tree with escaped names", () => {
		const markup = renderSpanTree([node(llm, [node(tool)])], NOW).value;
		expect(markup).toContain(`<details open><summary data-span-id="s1">`);
		expect(markup).toContain(`data-span-id="t"`);
		expectInert(markup);
		expect(findSpan([node(llm, [node(tool)])], "t")?.span.name).toBe("bash");
	});

	it("collapses nodes below the open depth", () => {
		const deep = node(span({ id: "a" }), [node(span({ id: "b" }), [node(span({ id: "c" }), [node(span({ id: "d" }))])])]);
		const markup = renderSpanTree([deep], NOW, 1).value;
		expect(markup.match(/<details open>/g)).toHaveLength(1);
	});

	it("escapes messages, tool input and output in the span detail", () => {
		expectInert(renderSpanDetail(llm, false, NOW).value);
		const markup = renderSpanDetail(tool, true, NOW).value;
		expectInert(markup);
		expect(markup).toContain(`data-full-span="t"`);
		const offloaded = renderSpanDetail(span({ payloadRef: "tool_outputs/x.txt" }), false, NOW).value;
		expect(offloaded).toContain(`data-file-path="tool_outputs/x.txt"`);
		expect(renderSpanDetail(span(), false, NOW).value).toContain("<dt>model source</dt><dd>skill</dd>");
	});
});

describe("timeline", () => {
	const root = span({ id: "r", kind: "run", name: "run", startedAt: "2026-10-10T10:00:00.000Z", endedAt: "2026-10-10T10:00:10.000Z" });
	const subA = span({ id: "a", kind: "subagent", name: XSS, queuedMs: 2000, startedAt: "2026-10-10T10:00:04.000Z", endedAt: "2026-10-10T10:00:08.000Z", attrs: { trajectoryId: "01J000000000000000000CHILD1", childCostUsd: 0.5 } });
	const subB = span({ id: "b", kind: "subagent", name: "b", startedAt: "2026-10-10T10:00:04.000Z", endedAt: null, attrs: {} });

	it("computes rows with queue wait, duration, cost and running state", () => {
		const t = timelineRows([node(root, [node(subA), node(subB)])], NOW);
		expect(t.totalMs).toBe(20_000);
		expect(t.rows.map((r) => [r.spanId, r.depth, r.queuedMs, r.durationMs, r.costUsd, r.running])).toEqual([
			["r", 0, 0, 10_000, 0.001, false],
			["a", 1, 2000, 4000, 0.5, false],
			["b", 1, 0, 16_000, 0.001, true],
		]);
		const markup = renderTimeline(t).value;
		expect(markup).toContain(`class="tl-queue" x="100.0" y="2" width="100.0"`);
		expect(markup).toContain("queued 2.0 s");
		expect(markup).toContain("(running)");
		expect(markup).not.toContain("style=");
		expectInert(markup);
	});

	it("handles an empty tree", () => {
		expect(timelineRows([], NOW)).toEqual({ rows: [], originMs: 0, totalMs: 0 });
		expect(renderTimeline(timelineRows([], NOW)).value).toContain("No run spans");
	});
});

describe("files view", () => {
	it("encodes file paths per segment", () => {
		expect(filePath("r1", "changes/after/a b#.txt")).toBe("/api/runs/r1/files/changes/after/a%20b%23.txt");
		expect(filePath("r1", "")).toBe("/api/runs/r1/files/");
		expect(filePath("r1", "x.txt", true)).toBe("/api/runs/r1/files/x.txt?full=1");
	});

	it("classifies and escapes diff lines", () => {
		const diff = `--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+${XSS}\n same\n`;
		expect(parseUnifiedDiff(diff).map((l) => l.kind)).toEqual(["meta", "meta", "hunk", "del", "add", "ctx"]);
		const markup = renderFile("changes/changes.diff", diff, null).value;
		expect(markup).toContain(`<span class="diff-add">+&lt;img`);
		expect(markup).not.toMatch(/<\/span>\s+<span/);
		expectInert(markup);
	});

	it("escapes file names and contents and offers the full file when truncated", () => {
		const listing = renderListing({ path: "changes/after", entries: [{ name: XSS, path: `changes/after/${XSS}`, kind: "file", size: 2048 }, { name: "d", path: "changes/after/d", kind: "dir", size: 0 }] }).value;
		expectInert(listing);
		expect(listing).toContain(`data-dir="changes"`);
		const links = renderListing({ path: "", entries: [{ name: "escape.txt", path: "escape.txt", kind: "symlink", size: 0 }, { name: XSS, path: "pipe", kind: "other", size: 0 }] }).value;
		expect(links).toContain(`data-file="escape.txt">escape.txt</button> <span class="muted">symlink</span>`);
		expect(links).not.toContain(`data-file="pipe"`);
		expectInert(links);
		const file = renderFile("notes.html", XSS, 5 * 1024 * 1024).value;
		expectInert(file);
		expect(file).toContain("first 1 MB of 5.0 MB");
	});
});

describe("cost view", () => {
	it("renders rows, totals and unknown-cost warnings with escaped keys", () => {
		const report: CostResponse = { by: "model", since: "2026-10-01", rows: [{ key: XSS, costUsd: 0.2, calls: 3, unknownCalls: 1 }, { key: "faux/b", costUsd: 0.1, calls: 1, unknownCalls: 0 }], totalUsd: 0.3, unknownCalls: 1 };
		const markup = renderCostTable(report).value;
		expectInert(markup);
		expect(markup).toContain("1 LLM call has no price");
		expect(markup).toContain(`width="50.0"`);
		expect(markup).toContain("$0.3000 + unpriced");
		expect(renderCostTable({ ...report, rows: [], totalUsd: 0, unknownCalls: 0 }).value).toContain("No LLM calls since 2026-10-01");
		expect(costQuery("tier", "")).toBe("/api/costs?by=tier");
		expect(costQuery("", "")).toBe("/api/costs");
		expect(renderDimensionOptions(["day", "model"], "model").value).toBe(`<option value="day">day</option><option value="model" selected>model</option>`);
	});
});

describe("common view", () => {
	it("escapes error fields and unknown statuses", () => {
		expectInert(renderError({ code: "X", message: XSS, retryable: false, hint: null }).value);
		expect(statusBadge(`"><script>`).value).toBe(`<span class="badge status-other">&quot;&gt;&lt;script&gt;</span>`);
	});
});

describe("poller", () => {
	function harness(results: (boolean | Error)[]) {
		const timers: { ms: number; fire: () => void; cleared: boolean }[] = [];
		let runs = 0;
		let release: (() => void) | null = null;
		const errors: unknown[] = [];
		let hold = false;
		const poller = createPoller({
			task: async () => {
				runs++;
				await new Promise<void>((resolve) => {
					release = resolve;
					if (!hold) resolve();
				});
				const next = results.shift() ?? false;
				if (next instanceof Error) throw next;
				return next;
			},
			onError: (error) => errors.push(error),
			setTimer: (fire, ms) => {
				const timer = { ms, fire, cleared: false };
				timers.push(timer);
				return timer;
			},
			clearTimer: (handle) => {
				(handle as { cleared: boolean }).cleared = true;
			},
		});
		return {
			poller,
			timers,
			errors,
			runs: () => runs,
			hold: (value: boolean) => {
				hold = value;
			},
			release: () => release?.(),
		};
	}

	it("keeps exactly one loop when refreshes overlap", async () => {
		const h = harness([true, true, true]);
		h.hold(true);
		const first = h.poller.refresh();
		const second = h.poller.refresh();
		const third = h.poller.refresh();
		h.hold(false);
		h.release();
		await Promise.all([first, second, third]);
		expect(h.runs()).toBe(2);
		expect(h.timers.filter((t) => !t.cleared)).toHaveLength(1);
		await h.poller.refresh();
		expect(h.timers.filter((t) => !t.cleared)).toHaveLength(1);
		expect(h.timers.map((t) => t.ms)).toEqual([POLL_MS, POLL_MS]);
	});

	it("reruns a refresh that lands right after the loop scheduled its tick", async () => {
		const timers: { cleared: boolean }[] = [];
		let runs = 0;
		let pending: Promise<void> | null = null;
		const poller = createPoller({
			task: async () => {
				runs++;
				return true;
			},
			onError: () => {},
			setTimer: () => {
				const timer = { cleared: false };
				timers.push(timer);
				// Queued while the loop is still finishing: runs before the loop's promise settles.
				if (runs === 1) queueMicrotask(() => void (pending = poller.refresh()));
				return timer;
			},
			clearTimer: (handle) => {
				(handle as { cleared: boolean }).cleared = true;
			},
		});
		await poller.refresh();
		await new Promise((r) => setTimeout(r, 0));
		await pending;
		expect(runs).toBe(2);
		expect(timers.filter((t) => !t.cleared)).toHaveLength(1);
	});

	it("keeps polling when onError throws", async () => {
		const timers: { fire: () => void }[] = [];
		const results: (boolean | Error)[] = [new Error("a"), true];
		const poller = createPoller({
			task: async () => {
				const next = results.shift() ?? false;
				if (next instanceof Error) throw next;
				return next;
			},
			onError: () => {
				throw new Error("render failed");
			},
			setTimer: (fire) => {
				const timer = { fire };
				timers.push(timer);
				return timer;
			},
			clearTimer: () => {},
		});
		await poller.refresh();
		await poller.refresh();
		expect(timers).toHaveLength(1);
	});

	it("stops when the run ends and does not retry a failed first load", async () => {
		const done = harness([false]);
		await done.poller.refresh();
		expect(done.timers).toEqual([]);
		const broken = harness([new Error("offline")]);
		await broken.poller.refresh();
		expect(broken.errors).toHaveLength(1);
		expect(broken.timers).toEqual([]);
	});

	it("retries failed polls with exponential backoff and resets after a success", async () => {
		const h = harness([true, new Error("a"), new Error("b"), true]);
		await h.poller.refresh();
		for (let i = 0; i < 3; i++) {
			h.timers.at(-1)?.fire();
			await new Promise((r) => setTimeout(r, 0));
		}
		expect(h.timers.map((t) => t.ms)).toEqual([POLL_MS, 2 * POLL_MS, 4 * POLL_MS, POLL_MS]);
		expect(h.errors).toHaveLength(2);
		expect(pollDelay(10)).toBe(MAX_POLL_BACKOFF_MS);
	});
});
