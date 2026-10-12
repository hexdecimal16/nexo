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

export function getArtifact(db: Db, id: string): ArtifactRow | undefined {
	const row = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id);
	return row ? decode(row) : undefined;
}

export function getActiveArtifact(db: Db, kind: ArtifactKind, name: string): ArtifactRow | undefined {
	const row = db.prepare("SELECT * FROM artifacts WHERE kind = ? AND name = ? AND status = 'active' ORDER BY version DESC LIMIT 1").get(kind, name);
	return row ? decode(row) : undefined;
}

/** Returns the active version when its content matches; otherwise stores a new active manual version and retires the old one. */
export function ensureManualArtifact(db: Db, kind: ArtifactKind, name: string, content: string, nowIso: string): ArtifactRow {
	return appendArtifactVersion(db, kind, name, content, "manual", nowIso);
}

/**
 * Returns the active version of a learnable artifact (router policy, judge rubric), creating version 1 from `seed` when
 * none exists. Unlike `ensureManualArtifact` it never replaces an active version, so a promoted version stays active.
 */
export function ensureSeedArtifact(db: Db, kind: ArtifactKind, name: string, seed: string, nowIso: string): ArtifactRow {
	const active = getActiveArtifact(db, kind, name);
	if (active) return active;
	return ensureManualArtifact(db, kind, name, seed, nowIso);
}

/**
 * Stores `content` as a new active version with the given origin and retires the previous active version; returns the
 * active version unchanged when its content already matches.
 */
export function appendArtifactVersion(
	db: Db,
	kind: ArtifactKind,
	name: string,
	content: string,
	origin: ArtifactRow["origin"],
	nowIso: string,
): ArtifactRow {
	const hash = sha256(content);
	return transaction(db, () => {
		const active = getActiveArtifact(db, kind, name);
		if (active && active.contentHash === hash) return active;
		const max = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM artifacts WHERE kind = ? AND name = ?").get(kind, name);
		const row: ArtifactRow = {
			id: newId(),
			kind,
			name,
			version: Number(max?.v ?? 0) + 1,
			content,
			contentHash: hash,
			parentVersionId: active?.id ?? null,
			origin,
			status: "active",
			createdAt: nowIso,
		};
		if (active) db.prepare("UPDATE artifacts SET status = 'retired' WHERE id = ?").run(active.id);
		db.prepare(
			"INSERT INTO artifacts (id, kind, name, version, content, content_hash, parent_version_id, origin, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(row.id, kind, name, row.version, content, hash, row.parentVersionId, origin, "active", nowIso);
		return row;
	});
}

/**
 * The version a run uses for an artifact whose text comes from a source (SKILL.md, a built-in prompt, a `file:`
 * rubric): a promoted (`gepa`) active version while the newest `manual` version still matches `source`, so a promotion
 * stays in use until the source is edited; otherwise `source` as the active manual version (`ensureManualArtifact`).
 */
export function resolveSourcedArtifact(db: Db, kind: ArtifactKind, name: string, source: string, nowIso: string): ArtifactRow {
	return transaction(db, () => {
		const active = getActiveArtifact(db, kind, name);
		if (active?.origin === "gepa") {
			const manual = db
				.prepare("SELECT content_hash FROM artifacts WHERE kind = ? AND name = ? AND origin = 'manual' ORDER BY version DESC LIMIT 1")
				.get(kind, name);
			if (manual && String(manual.content_hash) === sha256(source)) return active;
		}
		return appendArtifactVersion(db, kind, name, source, "manual", nowIso);
	});
}

/**
 * Stores an optimization candidate: a new version with status `candidate` and origin `gepa` whose parent is the
 * candidate it was derived from. The active version is not touched.
 */
export function insertCandidateArtifact(db: Db, kind: ArtifactKind, name: string, content: string, parentId: string, nowIso: string): ArtifactRow {
	return transaction(db, () => {
		const max = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM artifacts WHERE kind = ? AND name = ?").get(kind, name);
		const row: ArtifactRow = {
			id: newId(),
			kind,
			name,
			version: Number(max?.v ?? 0) + 1,
			content,
			contentHash: sha256(content),
			parentVersionId: parentId,
			origin: "gepa",
			status: "candidate",
			createdAt: nowIso,
		};
		db.prepare(
			"INSERT INTO artifacts (id, kind, name, version, content, content_hash, parent_version_id, origin, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'gepa', 'candidate', ?)",
		).run(row.id, kind, name, row.version, content, row.contentHash, parentId, nowIso);
		return row;
	});
}

/** Every version of an artifact, newest first. */
export function listArtifactVersions(db: Db, kind: ArtifactKind, name: string): ArtifactRow[] {
	return db.prepare("SELECT * FROM artifacts WHERE kind = ? AND name = ? ORDER BY version DESC").all(kind, name).map(decode);
}

/** Stores an artifact set keyed by the hash of its sorted members, so identical sets share one id. */
export function createArtifactSet(db: Db, members: readonly ArtifactSetMember[], nowIso: string): string {
	const sorted = [...members].sort((a, b) => `${a.kind}/${a.name}`.localeCompare(`${b.kind}/${b.name}`));
	const json = JSON.stringify(sorted);
	const id = sha256(json).slice(0, 32);
	db.prepare("INSERT OR IGNORE INTO artifact_sets (id, members_json, created_at) VALUES (?, ?, ?)").run(id, json, nowIso);
	return id;
}
