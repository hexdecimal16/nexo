import { describe, expect, it } from "vitest";
import { runCli } from "../src/main.ts";

describe.skipIf(!process.env.NEXO_LIVE)("live smoke (NEXO_LIVE=1)", () => {
	it("completes a tiny real run within $0.25", async () => {
		let err = "";
		const code = await runCli(["run", "--budget", "0.25", "Reply with exactly the word: ok"], {
			stdout: { write: () => true },
			stderr: { write: (s: string) => ((err += s), true) },
		});
		expect(code, err).toBe(0);
	}, 120_000);
});
