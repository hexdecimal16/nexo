import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createEngine, type SteeringControl } from "../src/index.ts";
import { scoredInstruction } from "../src/scoring/continuation.ts";
import { JUDGE, judgeEnv, route, verdict } from "./scoring-helpers.ts";

describe("scoredInstruction", () => {
	it("is the instruction alone when nothing was steered in", () => {
		expect(scoredInstruction("Do X", [])).toBe("Do X");
	});

	it("appends each steered message in order, numbered after the instruction", () => {
		const text = scoredInstruction("Do X", ["Also Y", "And Z"]);
		expect(text.startsWith("Do X\n\n")).toBe(true);
		expect(text).toContain("[Message 2 from the user");
		expect(text).toContain("[Message 3 from the user");
		expect(text.indexOf("Also Y")).toBeLessThan(text.indexOf("And Z"));
	});
});

describe("scoring a steered run", () => {
	it("gives the judge the messages the user steered in while the run worked", async () => {
		const env = judgeEnv({ config: JUDGE });
		let control: SteeringControl | undefined;
		const calls = route(
			env,
			[
				async () => {
					control?.steer("check the kiro-cli 3.7.0 changelog instead");
					return fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" })]);
				},
				fauxAssistantMessage("changelog summary"),
			],
			[verdict(0.9)],
		);
		const result = await createEngine(env.deps).run({
			instruction: "why is it slow",
			onSteeringReady: (c) => {
				control = c;
			},
		});
		expect(result).toMatchObject({ status: "succeeded", output: "changelog summary" });
		expect(calls.judgeCalls()).toBe(1);
		expect(calls.prompts[0]).toContain("why is it slow");
		expect(calls.prompts[0]).toContain("check the kiro-cli 3.7.0 changelog instead");
	});
});
