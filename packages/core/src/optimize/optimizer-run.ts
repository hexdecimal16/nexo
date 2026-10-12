import { insertRun, type OptimTarget, RunDir, type RunJson, type RunStatus, updateRun } from "@nexo/store";
import type { ErrorPayload } from "@nexo/telemetry";
import { Recorder } from "../engine/recorder.ts";
import type { EngineEnv } from "../engine/run.ts";

/** The optimizer's own run (D16): its directory is the optimization directory and its spans hold the reflection calls. */
export interface OptimizerRun {
	id: string;
	runDir: RunDir;
	recorder: Recorder;
	/** The `optimize` span every reflection and judge-rubric call hangs under. */
	spanId: string;
	startedAt: string;
	instruction: string;
}

function runJson(run: OptimizerRun, env: EngineEnv, status: RunStatus, extra: { costUsd: number; costUnknown: boolean; error: ErrorPayload | null; output: string }): RunJson {
	return {
		id: run.id,
		parentRunId: null,
		rootRunId: run.id,
		instruction: run.instruction,
		skill: null,
		status,
		model: null,
		startedAt: run.startedAt,
		endedAt: status === "running" ? null : env.now().toISOString(),
		costUsd: extra.costUsd,
		costUnknown: extra.costUnknown,
		tokensIn: 0,
		tokensOut: 0,
		output: extra.output,
		error: extra.error,
		artifactSetId: null,
		configSnapshotHash: env.deps.configHash,
		workspace: run.runDir.workspaceDir,
		taskGraphs: [],
		optimRunId: run.id,
	};
}

/** Creates the optimization directory (`~/.nexo/optim/<id>`), the optimizer's run row and its `optimize` span. */
export function openOptimizerRun(env: EngineEnv, optimRunId: string, target: OptimTarget): OptimizerRun {
	const { db, redact, paths } = env.deps;
	const runDir = RunDir.create(paths.optim, optimRunId, redact);
	const startedAt = env.now().toISOString();
	const instruction = `optimize ${target.key}`;
	insertRun(db, {
		id: optimRunId,
		parentRunId: null,
		rootRunId: optimRunId,
		dirPath: runDir.root,
		instruction,
		skill: null,
		status: "running",
		configSnapshotHash: env.deps.configHash,
		artifactSetId: null,
		modelFinal: null,
		tierFinal: null,
		escalations: 0,
		startedAt,
		endedAt: null,
		costUsd: 0,
		costUnknown: false,
		tokensIn: 0,
		tokensOut: 0,
		pid: process.pid,
		error: null,
		optimRunId,
	});
	const recorder = new Recorder({ db, runDir, runId: optimRunId, now: env.now, redact });
	const run: OptimizerRun = { id: optimRunId, runDir, recorder, spanId: "", startedAt, instruction };
	run.spanId = recorder.start({ kind: "optimize", name: target.key, parentSpanId: null, attrs: { target: target.key } });
	runDir.writeRunJson(runJson(run, env, "running", { costUsd: 0, costUnknown: false, error: null, output: "" }));
	return run;
}

/** Finishes the optimizer's span, run row and run.json; `costUsd` is what the optimizer's own calls cost. */
export function closeOptimizerRun(env: EngineEnv, run: OptimizerRun, end: { status: RunStatus; costUsd: number; costUnknown: boolean; error: ErrorPayload | null; output: string }): void {
	run.recorder.finish(run.spanId, { status: end.status === "succeeded" ? "ok" : "error", attrs: { status: end.status } });
	updateRun(env.deps.db, run.id, { status: end.status, endedAt: env.now().toISOString(), costUsd: end.costUsd, costUnknown: end.costUnknown, error: end.error });
	run.runDir.writeRunJson(runJson(run, env, end.status, end));
}
