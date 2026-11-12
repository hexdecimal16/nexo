import { approveArea, readRegistry, writeRegistry } from "@nexo/core";
import { ensureNexoDirs, resolveNexoPaths } from "@nexo/store";
import { NexoError } from "@nexo/telemetry";
import { type CliIO, type CliOptions, usageError } from "./common.ts";

const AREAS_USAGE = "Usage: nexo areas [list] | nexo areas approve <id> | nexo areas reject <id>";

/** `nexo areas`: lists life areas and the unsorted queue; approve activates a proposed area, reject removes one. */
export function areasCommand(args: string[], io: CliIO, options: CliOptions): number {
	const [sub = "list", id, ...extra] = args;
	if (extra.length > 0) throw usageError(AREAS_USAGE);
	const paths = resolveNexoPaths(options.env ?? process.env);
	ensureNexoDirs(paths);
	const registry = readRegistry(paths.homeRoot);
	if (sub === "list") {
		if (registry.areas.length === 0) {
			io.stdout.write("No areas yet.\n");
			return 0;
		}
		for (const status of ["active", "proposed"] as const) {
			const areas = registry.areas.filter((a) => a.status === status);
			if (areas.length === 0) continue;
			io.stdout.write(status === "active" ? "Active:\n" : "Proposed (approve with: nexo areas approve <id>):\n");
			for (const a of areas) io.stdout.write(`  ${a.id.padEnd(10)} ${a.name}: ${a.scope}${a.wikis.length > 0 ? ` [wikis: ${a.wikis.join(", ")}]` : ""}\n`);
		}
		const labels = new Map<string, number>();
		for (const u of registry.unsorted) labels.set(u.label, (labels.get(u.label) ?? 0) + 1);
		if (labels.size > 0) io.stdout.write(`Unsorted: ${[...labels].map(([l, n]) => `${l} (${n})`).join(", ")}\n`);
		return 0;
	}
	if ((sub !== "approve" && sub !== "reject") || !id) throw usageError(AREAS_USAGE);
	if (sub === "approve") {
		writeRegistry(paths.homeRoot, approveArea(registry, id));
		io.stdout.write(`Approved area ${id}\n`);
		return 0;
	}
	const area = registry.areas.find((a) => a.id === id);
	if (!area) throw new NexoError({ code: "NOT_FOUND", message: `No area "${id}"`, context: { id } });
	if (area.status !== "proposed") throw new NexoError({ code: "CONFLICT", message: `Area "${id}" is active; only proposed areas can be rejected`, context: { id } });
	writeRegistry(paths.homeRoot, { ...registry, areas: registry.areas.filter((a) => a.id !== id) });
	io.stdout.write(`Rejected area ${id}\n`);
	return 0;
}
