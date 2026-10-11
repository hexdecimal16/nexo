#!/usr/bin/env node
import { abortOnSignals, EXIT_SIGINT, EXIT_SIGTERM, runCli } from "./main.ts";

// Child processes of tools run in their own process groups and are only killed through the run's abort signal.
const controller = new AbortController();
const signals = abortOnSignals(process, controller);
const exitCodeFor = (code: number): number => (code === EXIT_SIGINT && signals.received() === "SIGTERM" ? EXIT_SIGTERM : code);
const code = await runCli(
	process.argv.slice(2),
	{ stdout: process.stdout, stderr: process.stderr },
	{
		signal: controller.signal,
		// Interactive mode exits explicitly: a turn that ignored its abort must not keep the process alive.
		exit: (exitCode) => process.exit(exitCodeFor(exitCode)),
	},
);
process.exitCode = exitCodeFor(code);
