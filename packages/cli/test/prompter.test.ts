import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createTtyPrompter } from "../src/prompter.ts";

function fakeTty(terminal: boolean): { input: PassThrough; output: PassThrough } {
	const input = new PassThrough();
	const output = new PassThrough();
	output.resume();
	if (terminal) {
		Object.assign(input, { isTTY: true, setRawMode: () => input });
		Object.assign(output, { isTTY: true, columns: 80 });
	}
	return { input, output };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("createTtyPrompter", () => {
	it("answers concurrent approvals one at a time, so one keystroke approves only the first", async () => {
		const { input, output } = fakeTty(false);
		const prompter = createTtyPrompter(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream);
		let secondSettled = false;
		const first = prompter.approve({ question: "Allow bash: ls?" });
		const second = prompter.approve({ question: "Allow bash: rm -rf build?" }).then((v) => {
			secondSettled = true;
			return v;
		});
		await tick();
		input.write("y\n");
		expect(await first).toBe("once");
		await tick();
		expect(secondSettled).toBe(false);
		input.write("n\n");
		expect(await second).toBe("deny");
	});

	it("shows each question only when its turn comes", async () => {
		const { input, output } = fakeTty(false);
		let shown = "";
		output.on("data", (chunk: Buffer) => {
			shown += chunk.toString();
		});
		const prompter = createTtyPrompter(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream);
		const first = prompter.approve({ question: "Q1?" });
		const second = prompter.approve({ question: "Q2?" });
		await tick();
		expect(shown).toContain("Q1?");
		expect(shown).not.toContain("Q2?");
		input.write("y\n");
		await first;
		await tick();
		expect(shown).toContain("Q2?");
		input.write("y\n");
		expect(await second).toBe("once");
	});

	it("declines without asking when the signal is already aborted", async () => {
		const { input, output } = fakeTty(false);
		const prompter = createTtyPrompter(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream);
		expect(await prompter.approve({ question: "Q?" }, AbortSignal.abort())).toBe("deny");
	});

	it("calls onInterrupt when Ctrl-C is pressed at the prompt", async () => {
		const { input, output } = fakeTty(true);
		const onInterrupt = vi.fn();
		const prompter = createTtyPrompter(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream, { onInterrupt });
		const answer = prompter.approve({ question: "Allow bash: ls?" }, new AbortController().signal);
		await tick();
		input.write("\x03");
		expect(await answer).toBe("deny");
		expect(onInterrupt).toHaveBeenCalledTimes(1);
	});

	it("does not call onInterrupt when the run's own signal aborts the prompt", async () => {
		const { input, output } = fakeTty(true);
		const onInterrupt = vi.fn();
		const prompter = createTtyPrompter(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream, { onInterrupt });
		const ac = new AbortController();
		const answer = prompter.approve({ question: "Allow bash: ls?" }, ac.signal);
		await tick();
		ac.abort();
		expect(await answer).toBe("deny");
		expect(onInterrupt).not.toHaveBeenCalled();
	});

	it("offers a for Always allow, shows the note, and answers settled requests without asking", async () => {
		let shown = "";
		const first = fakeTty(false);
		first.output.on("data", (chunk: Buffer) => {
			shown += chunk.toString();
		});
		const prompter = createTtyPrompter(first.input as unknown as NodeJS.ReadStream, first.output as unknown as NodeJS.WriteStream);
		const always = prompter.approve({ question: "Allow bash: npm run test?", note: "auto: watch mode", alwaysLabel: "Always allow `npm run test …` this session" });
		await tick();
		first.input.write("a\n");
		expect(await always).toBe("always");
		expect(shown).toContain("auto: watch mode");
		expect(shown).toContain("a = Always allow `npm run test …` this session");
		expect(shown).toContain("[y/a/N]");
		expect(await prompter.approve({ question: "Allow bash: ls?", settled: () => true })).toBe("once");
		// Without alwaysLabel, "a" is not an answer.
		const second = fakeTty(false);
		let secondShown = "";
		second.output.on("data", (chunk: Buffer) => {
			secondShown += chunk.toString();
		});
		const plain = createTtyPrompter(second.input as unknown as NodeJS.ReadStream, second.output as unknown as NodeJS.WriteStream).approve({ question: "Allow bash: ls?" });
		await tick();
		second.input.write("a\n");
		expect(await plain).toBe("deny");
		expect(secondShown).toContain("[y/N]");
	});
});
