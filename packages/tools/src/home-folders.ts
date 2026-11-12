import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Folders live one level under an area: <homeRoot>/<area>/<name>/. */
export interface HomeFolder {
	area: string;
	name: string;
	dir: string;
}

/** Where a new folder goes before it has an area. */
export const UNSORTED_AREA = "unsorted";

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Every <area>/<name> folder under the home root, sorted by area then name. */
export function listHomeFolders(root: string): HomeFolder[] {
	if (!existsSync(root)) return [];
	const out: HomeFolder[] = [];
	for (const area of readdirSync(root).sort()) {
		if (area.startsWith(".")) continue;
		const areaDir = join(root, area);
		if (!isDir(areaDir)) continue;
		for (const name of readdirSync(areaDir).sort()) {
			if (name.startsWith(".")) continue;
			const dir = join(areaDir, name);
			if (isDir(dir)) out.push({ area, name, dir });
		}
	}
	return out;
}

export function findHomeFolder(root: string, name: string): HomeFolder | undefined {
	return listHomeFolders(root).find((f) => f.name === name);
}
