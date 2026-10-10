#!/usr/bin/env node
import { abortOnSignals, EXIT_SIGINT, EXIT_SIGTERM, runCli } from "./main.ts";

// Child processes of tools run in their own process groups and are only killed through the run's abort signal.
const controller = new AbortController();
const signals = abortOnSignals(process, controller);
const code = await runCli(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr }, { signal: controller.signal });
process.exitCode = code === EXIT_SIGINT && signals.received() === "SIGTERM" ? EXIT_SIGTERM : code;
