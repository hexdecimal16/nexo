import type { EngineEvent } from "@nexo/core";

type RunStart = Extract<EngineEvent, { type: "run_start" }>;
type RunEnd = Extract<EngineEvent, { type: "run_end" }>;

/** One run in a run tree: the root run or a subagent. Nodes are live objects that update as events arrive. */
export interface RunNode {
	runId: string;
	parentRunId: string | null;
	/** The spawn task id for a subagent; null for the root run. */
	taskId: string | null;
	depth: number;
	instruction: string;
	model: string;
	effort: RunStart["effort"];
	status: "running" | RunEnd["status"];
	costUsd: number;
	toolCalls: number;
	/** Tool calls the loop guard blocked (repeated identical calls or the max-tool-calls cap). */
	loopGuards: number;
	/** Name of the tool in flight, or null. */
	currentTool: string | null;
	error: { code: string; message: string } | null;
	startedAt: number;
	endedAt: number | null;
	children: RunNode[];
}

export interface RunTree {
	/** Pass to `onEvent` of `nexo.run` or `session.turn`. */
	onEvent(event: EngineEvent): void;
	/** Top-level runs (usually one). */
	roots(): RunNode[];
	get(runId: string): RunNode | undefined;
	reset(): void;
}

/**
 * Folds engine events into a tree of runs with status, cost, tool count and error per node, so callers do not have to
 * rebuild the subagent hierarchy from the flat event stream. `onChange` fires after every update of a node.
 */
export function trackRunTree(onChange?: (node: RunNode) => void): RunTree {
	const nodes = new Map<string, RunNode>();
	const roots: RunNode[] = [];
	const update = (runId: string, apply: (node: RunNode) => void): void => {
		const node = nodes.get(runId);
		if (!node) return;
		apply(node);
		onChange?.(node);
	};
	return {
		onEvent(event) {
			switch (event.type) {
				case "run_start": {
					const node: RunNode = {
						runId: event.runId,
						parentRunId: event.parentRunId,
						taskId: event.taskId ?? null,
						depth: event.depth,
						instruction: event.instruction,
						model: event.model,
						effort: event.effort,
						status: "running",
						costUsd: 0,
						toolCalls: 0,
						loopGuards: 0,
						currentTool: null,
						error: null,
						startedAt: Date.now(),
						endedAt: null,
						children: [],
					};
					nodes.set(node.runId, node);
					const parent = event.parentRunId ? nodes.get(event.parentRunId) : undefined;
					if (parent) parent.children.push(node);
					else roots.push(node);
					onChange?.(node);
					break;
				}
				case "tool_start":
					update(event.runId, (n) => {
						n.toolCalls++;
						n.currentTool = event.toolName;
					});
					break;
				case "loop_guard":
					update(event.runId, (n) => {
						n.loopGuards++;
					});
					break;
				case "tool_end":
					update(event.runId, (n) => {
						n.currentTool = null;
					});
					break;
				case "llm_end":
					update(event.runId, (n) => {
						n.costUsd += event.costUsd;
					});
					break;
				case "run_end":
					update(event.runId, (n) => {
						n.status = event.status;
						n.costUsd = event.costUsd;
						n.currentTool = null;
						n.error = event.error ?? null;
						n.endedAt = Date.now();
					});
					break;
				default:
					break;
			}
		},
		roots: () => roots,
		get: (runId) => nodes.get(runId),
		reset() {
			nodes.clear();
			roots.length = 0;
		},
	};
}
