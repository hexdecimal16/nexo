// Fetch helpers for the pages. The token comes from the <meta name="nexo-token"> tag the server fills in.
import type { ApiErrorBody } from "../lib/api-types.ts";

export class ApiError extends Error {
	readonly body: ApiErrorBody;

	constructor(body: ApiErrorBody) {
		super(body.message);
		this.body = body;
	}
}

function token(): string {
	return document.querySelector<HTMLMetaElement>('meta[name="nexo-token"]')?.content ?? "";
}

async function failure(res: Response): Promise<ApiError> {
	try {
		const body = (await res.json()) as { error?: ApiErrorBody };
		if (body.error) return new ApiError(body.error);
	} catch {
		// Falls through to the generic error below.
	}
	return new ApiError({ code: "INTERNAL", message: `HTTP ${res.status}`, retryable: res.status >= 500 });
}

export async function getJson<T>(path: string): Promise<T> {
	const res = await fetch(path, { headers: { accept: "application/json" } });
	if (!res.ok) throw await failure(res);
	return (await res.json()) as T;
}

export async function getText(path: string): Promise<{ text: string; truncatedSize: number | null }> {
	const res = await fetch(path);
	if (!res.ok) throw await failure(res);
	const truncated = res.headers.get("x-nexo-truncated");
	return { text: await res.text(), truncatedSize: truncated === null ? null : Number(truncated) };
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
	const res = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json", "x-nexo-token": token() },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw await failure(res);
	return (await res.json()) as T;
}

export function asErrorBody(error: unknown): ApiErrorBody {
	if (error instanceof ApiError) return error.body;
	return { code: "INTERNAL", message: error instanceof Error ? error.message : String(error), retryable: false };
}

/** Looks up an element the page's HTML is required to contain. */
export function el<T extends HTMLElement>(selector: string): T {
	const found = document.querySelector<T>(selector);
	if (!found) throw new Error(`Missing element ${selector}`);
	return found;
}
