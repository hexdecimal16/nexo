import { describe, expect, it } from "vitest";
import { parseTtyAnswer } from "../src/prompter.ts";

const q = { question: "Which?", options: [{ label: "A" }, { label: "B" }, { label: "C" }] };

describe("parseTtyAnswer", () => {
	it("maps numbers to option labels and anything else to typed text", () => {
		expect(parseTtyAnswer(q, "2")).toEqual({ question: "Which?", selected: ["B"] });
		expect(parseTtyAnswer({ ...q, multiSelect: true }, "3, 1")).toEqual({ question: "Which?", selected: ["A", "C"] });
		expect(parseTtyAnswer(q, "1,3")).toEqual({ question: "Which?", selected: [], text: "1,3" });
		expect(parseTtyAnswer(q, "9")).toEqual({ question: "Which?", selected: [], text: "9" });
		expect(parseTtyAnswer(q, "something else")).toEqual({ question: "Which?", selected: [], text: "something else" });
	});
});
