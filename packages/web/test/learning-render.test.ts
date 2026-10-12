import { describe, expect, it } from "vitest";
import type { LearnJobsResponse, Memory, PlaybookItem, PlaybookResponse } from "../public/lib/api-types.ts";
import { memoriesQuery, renderJobs, renderMemories, renderMemoryHistory, renderPlaybook, renderPlaybookList } from "../public/lib/learning-view.ts";

const XSS = `<img src=x onerror="alert(1)"><script>alert('x')</script>\``;

function expectInert(markup: string): void {
	expect(markup).not.toContain("<script");
	expect(markup).not.toContain("<img");
	expect(markup).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
}

function memory(overrides: Partial<Memory> = {}): Memory {
	return {
		id: "01MEM",
		scope: "user",
		type: "lesson",
		content: `Remember ${XSS}`,
		importance: 0.7,
		source: "ace",
		sourceRunId: "01RUN",
		supersededBy: null,
		retiredAt: null,
		createdAt: "2026-10-12T00:00:00.000Z",
		lastUsedAt: null,
		...overrides,
	};
}

function item(overrides: Partial<PlaybookItem> = {}): PlaybookItem {
	return {
		id: "01ITEM",
		skill: "ci",
		key: "k001",
		content: `Tip ${XSS}`,
		helpful: 3,
		harmful: 1,
		source: "human",
		status: "active",
		sourceRunId: null,
		createdAt: "2026-10-12T00:00:00.000Z",
		updatedAt: "2026-10-12T00:00:00.000Z",
		history: [{ id: "h1", itemId: "01ITEM", action: "add", content: XSS, actor: "human", runId: "01RUN", createdAt: "2026-10-12T00:00:00.000Z" }],
		...overrides,
	};
}

describe("learning views", () => {
	it("builds the memories query from the filter form", () => {
		expect(memoriesQuery("", "", false)).toBe("/api/memories");
		expect(memoriesQuery(" skill:ci ", "lesson", true)).toBe("/api/memories?scope=skill%3Aci&type=lesson&all=1");
	});

	it("renders memories inert, with retire only for live memories and never read-only", () => {
		const markup = renderMemories([memory(), memory({ id: "01OLD", retiredAt: "2026-10-12T01:00:00.000Z" })], false).value;
		expectInert(markup);
		expect(markup.match(/data-retire-memory=/g)).toHaveLength(1);
		expect(markup).toContain('data-memory-history="01OLD"');
		expect(markup).toContain('href="/run.html?id=01RUN"');
		expect(renderMemories([memory()], true).value).not.toContain("data-retire-memory");
		expect(renderMemories([], false).value).toContain("No memories match");
		expectInert(renderMemoryHistory([memory()]).value);
	});

	it("renders playbooks inert with counters, history, retire buttons and versions", () => {
		const data: PlaybookResponse = {
			skill: "ci",
			items: [item(), item({ key: "k002", status: "retired", source: "ace" })],
			versions: [
				{ id: "a2", version: 2, origin: "manual", status: "active", createdAt: "2026-10-12T00:00:00.000Z" },
				{ id: "a1", version: 1, origin: "ace", status: "retired", createdAt: "2026-10-11T00:00:00.000Z" },
			],
		};
		const markup = renderPlaybook(data, false).value;
		expectInert(markup);
		expect(markup).toContain('data-retire-item="k001" data-skill="ci"');
		expect(markup).not.toContain('data-retire-item="k002"');
		expect(markup).toContain("v2 (manual, active), v1 (ace)");
		expect(markup).toContain("add by human");
		expect(renderPlaybook(data, true).value).not.toContain("data-retire-item");
		expect(renderPlaybookList({ playbooks: [{ skill: "ci", activeItems: 1, version: 2, origin: "manual" }] }).value).toContain('data-playbook="ci"');
	});

	it("renders job counts and errors inert", () => {
		const data: LearnJobsResponse = {
			counts: { pending: 1, running: 0, succeeded: 2, failed: 1 },
			jobs: [{ id: "j", runId: "01RUN", kind: "reflect", trigger: "run_end", status: "failed", attempts: 3, lastError: { code: "SCORER_FAILED", message: XSS, retryable: false }, createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z" }],
		};
		const markup = renderJobs(data).value;
		expectInert(markup);
		expect(markup).toContain("1 failed");
		expect(markup).toContain("nexo learn --retry");
	});
});
