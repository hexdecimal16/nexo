import { describe, expect, it } from "vitest";
import { createAskUserTool, nonInteractivePrompter, type Prompter } from "../src/index.ts";

const params = { questions: [{ question: "Scope?", options: [{ label: "Small" }, { label: "Large" }] }] };
const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");

describe("ask_user tool", () => {
	it("returns the prompter's answers as Q/A text", async () => {
		const prompter: Prompter = { interactive: true, approve: async () => "deny", ask: async () => ({ answers: [{ question: "Scope?", selected: ["Small"], text: "only the inbox" }] }) };
		const result = await createAskUserTool({ prompter }).execute("id", params);
		expect(text(result)).toBe("Q: Scope?\nA: Small, (typed) only the inbox");
	});

	it("tells the model to proceed when the user declines or nobody can answer", async () => {
		const declining: Prompter = { interactive: true, approve: async () => "deny", ask: async () => null };
		expect(text(await createAskUserTool({ prompter: declining }).execute("id", params))).toContain("declined");
		const headless = await createAskUserTool({ prompter: nonInteractivePrompter }).execute("id", params);
		expect(text(headless)).toContain("UNAVAILABLE");
	});
});
