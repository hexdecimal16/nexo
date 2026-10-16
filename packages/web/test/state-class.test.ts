import { describe, expect, it } from "vitest";
import { stateClass } from "../public/lib/common-view.ts";

describe("stateClass", () => {
	it("maps run statuses to spine states", () => {
		expect(stateClass("succeeded")).toBe("state-ok");
		expect(stateClass("running")).toBe("state-running");
		expect(stateClass("budget_exceeded")).toBe("state-bad");
		expect(stateClass("queued")).toBe("state-none");
	});
});
