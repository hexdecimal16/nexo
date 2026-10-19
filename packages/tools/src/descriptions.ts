import { tmpdir } from "node:os";
import { createBuiltinTools } from "./builtin.ts";
import { FileLeases } from "./leases.ts";

/**
 * The built-in tools' own descriptions by tool name: the text an optimization of `tool:<name>` starts from and a run
 * uses when no promoted or candidate description replaces it. Read from the tools themselves, so there is one copy.
 */
export function builtinToolDescriptions(): Record<string, string> {
	const tools = createBuiltinTools({ workspaceRoot: tmpdir(), holder: "descriptions", leases: new FileLeases(), bashTimeoutMs: 1 });
	return Object.fromEntries(tools.map((t) => [t.name, t.description]));
}
