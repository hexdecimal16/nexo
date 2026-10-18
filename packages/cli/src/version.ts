import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * nexo's version. In the repo it is packages/cli/package.json (one level above src); in the published package the
 * compiled file sits in cli/src and the package.json is at the package root (two levels above).
 */
export function nexoVersion(): string {
	for (const relative of ["../package.json", "../../package.json"]) {
		try {
			const json = JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")) as { version?: unknown };
			if (typeof json.version === "string") return json.version;
		} catch {
			// not at this location; try the next one
		}
	}
	return "unknown";
}
