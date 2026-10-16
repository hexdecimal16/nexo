import { describe, expect, it } from "vitest";
import { stateClass, statusBadge, verdictBadge } from "../public/lib/common-view.ts";

describe("stateClass", () => {
	it("maps run statuses to spine states", () => {
		expect(stateClass("succeeded")).toBe("state-ok");
		expect(stateClass("running")).toBe("state-running");
		expect(stateClass("budget_exceeded")).toBe("state-bad");
		expect(stateClass("queued")).toBe("state-none");
	});
});

describe("status glyphs", () => {
	it("put a hidden glyph before the status word", () => {
		expect(statusBadge("failed").value).toBe('<span class="badge status-failed"><span class="glyph" aria-hidden="true">✕</span> failed</span>');
		expect(statusBadge("budget_exceeded").value).toContain("</span> budget exceeded</span>");
		expect(verdictBadge("done").value).toContain('aria-hidden="true">✓</span> done');
		expect(verdictBadge(null).value).toContain("</span> unreviewed");
	});
});
