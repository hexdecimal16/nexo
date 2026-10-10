import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuiltinTools, FileLeases, trackedBashGroups } from "../src/index.ts";

const ws = mkdtempSync(join(tmpdir(), "nexo-ws-"));
const bash = createBuiltinTools({ workspaceRoot: ws, holder: "run-1", leases: new FileLeases(), bashTimeoutMs: 60000 }).find((t) => t.name === "bash");
void bash?.execute("1", { command: "sleep 31; echo x" });
setTimeout(() => {
	console.log(JSON.stringify(trackedBashGroups()));
	process.exit(0);
}, 500);
