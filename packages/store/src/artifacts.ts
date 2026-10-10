import { createHash } from "node:crypto";
import type { Db } from "./db.ts";
import { transaction } from "./db.ts";
import { newId } from "./ids.ts";

export type ArtifactKind = "system_prompt" | "skill" | "playbook" | "router_policy" | "judge_rubric" | "planner_prompt";

export interface ArtifactRow {
	id: string;
	kind: ArtifactKind;
	name: string;
	version: number;
	content: string;
	contentHash: string;
	parentVersionId: string | null;
	origin: "manual" | "ace" | "gepa";
	status: "active" | "candidate" | "retired";
	createdAt: string;
}

export interface ArtifactSetMember {
	kind: ArtifactKind;
	name: string;
	artifactId: string;
	version: number;
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function decode(row: Record<string, unknown>): ArtifactRow {
	return {
		id: String(row.id),
		kind: row.kind as ArtifactKind,
		name: String(row.name),
		version: Number(row.version),
		content: String(row.content),
		contentHash: String(row.content_hash),
		parentVersionId: row.parent_version_id ? String(row.parent_version_id) : null,
		origin: row.origin as ArtifactRow["origin"],
		status: row.status as ArtifactRow["status"],
		createdAt: String(row.created_at),
	};
}

export function getActiveArtifact(db: Db, kind: ArtifactKind, name: string): ArtifactRow | undefined {
	const row = db.prepare("SELECT * FROM artifacts WHERE kind = ? AND name = ? AND status = 'active'").get(kind, name);
	return row ? decode(row) : undefined;
}

/** Returns the active version when its content matches; otherwise stores a new active manual version and retires the old one. */
export function ensureManualArtifact(db: Db, kind: ArtifactKind, name: string, content: string, nowIso: string): ArtifactRow {
	const hash = sha256(content);
	const active = getActiveArtifact(db, kind, name);
	if (active && active.contentHash === hash) return active;
	return transaction(db, () => {
		const max = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM artifacts WHERE kind = ? AND name = ?").get(kind, name);
		const row: ArtifactRow = {
			id: newId(),
			kind,
			name,
			version: Number(max?.v ?? 0) + 1,
			content,
			contentHash: hash,
			parentVersionId: active?.id ?? null,
			origin: "manual",
			status: "active",
			createdAt: nowIso,
		};
		if (active) db.prepare("UPDATE artifacts SET status = 'retired' WHERE id = ?").run(active.id);
		db.prepare(
			"INSERT INTO artifacts (id, kind, name, version, content, content_hash, parent_version_id, origin, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(row.id, kind, name, row.version, content, hash, row.parentVersionId, "manual", "active", nowIso);
		return row;
	});
}

/** Stores an artifact set keyed by the hash of its sorted members, so identical sets share one id. */
export function createArtifactSet(db: Db, members: readonly ArtifactSetMember[], nowIso: string): string {
	const sorted = [...members].sort((a, b) => `${a.kind}/${a.name}`.localeCompare(`${b.kind}/${b.name}`));
	const json = JSON.stringify(sorted);
	const id = sha256(json).slice(0, 32);
	db.prepare("INSERT OR IGNORE INTO artifact_sets (id, members_json, created_at) VALUES (?, ?, ?)").run(id, json, nowIso);
	return id;
}
