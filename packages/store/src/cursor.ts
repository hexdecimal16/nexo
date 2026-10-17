import { invalidRequest } from "./errors.ts";

/** An opaque keyset cursor: the sort key and id of the last row of a page, so the next page starts after it. */
export function encodeCursor(key: string, id: string): string {
	return Buffer.from(JSON.stringify([key, id])).toString("base64url");
}

export function decodeCursor(cursor: string): { key: string; id: string } {
	try {
		const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string") return { key: value[0], id: value[1] };
	} catch {
		// Falls through to the error below.
	}
	throw invalidRequest("cursor is not a cursor returned by this API", { cursor });
}

/** The first `limit` of `limit + 1` fetched rows, with the cursor for the next page when the extra row showed there is one. */
export function pageOf<T>(rows: T[], limit: number, keyOf: (row: T) => { key: string; id: string }): { items: T[]; nextCursor: string | null } {
	const items = rows.slice(0, limit);
	const last = items.at(-1);
	return { items, nextCursor: rows.length > limit && last ? encodeCursor(keyOf(last).key, keyOf(last).id) : null };
}

/** `limit` as an integer from 1 to `max`, or INVALID_REQUEST. */
export function checkLimit(limit: number, max: number): number {
	if (!Number.isInteger(limit) || limit < 1 || limit > max) throw invalidRequest(`limit must be an integer from 1 to ${max}`, { limit });
	return limit;
}
