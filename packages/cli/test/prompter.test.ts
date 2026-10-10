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
	it("answers concurrent confirms one at a time, so one keystroke approves only the first", async () => {
		const { input, output } = fakeTty(false);
		const prompter = createTtyPrompter(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream);
		let secondSettled = false;
		const first = prompter.confirm("Allow bash: ls?");
		const second = prompter.confirm("Allow bash: rm -rf build?").then((v) => {
			secondSettled = true;
			return v;
		});
		await tick();
		input.write("y\n");
		expect(await first).toBe(true);
		await tick();
		expect(secondSettled).toBe(false);
		input.write("n\n");
		expect(await second).toBe(false);
	});

	it("shows each question only when its turn comes", async () => {
		const { input, output } = fakeTty(false);
		let shown = "";
		output.on("data", (chunk: Buffer) => {
			shown += chunk.toString();
		});
		const prompter = createTtyPrompter(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream);
		const first = prompter.confirm("Q1?");
		const second = prompter.confirm("Q2?");
		await tick();
		expect(shown).toContain("Q1?");
		expect(shown).not.toContain("Q2?");
		input.write("y\n");
		await first;
		await tick();
		expect(shown).toContain("Q2?");
		input.write("y\n");
		expect(await second).toBe(true);
	});

	it("declines without asking when the signal is already aborted", async () => {
		const { input, output } = fakeTty(false);
		const prompter = createTtyPrompter(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream);
		expect(await prompter.confirm("Q?", AbortSignal.abort())).toBe(false);
	});

	it("calls onInterrupt when Ctrl-C is pressed at the prompt", async () => {
		const { input, output } = fakeTty(true);
		const onInterrupt = vi.fn();
		const prompter = createTtyPrompter(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream, { onInterrupt });
		const answer = prompter.confirm("Allow bash: ls?", new AbortController().signal);
		await tick();
		input.write("\x03");
		expect(await answer).toBe(false);
		expect(onInterrupt).toHaveBeenCalledTimes(1);
	});

	it("does not call onInterrupt when the run's own signal aborts the prompt", async () => {
		const { input, output } = fakeTty(true);
		const onInterrupt = vi.fn();
		const prompter = createTtyPrompter(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream, { onInterrupt });
		const ac = new AbortController();
		const answer = prompter.confirm("Allow bash: ls?", ac.signal);
		await tick();
		ac.abort();
		expect(await answer).toBe(false);
		expect(onInterrupt).not.toHaveBeenCalled();
	});
});
