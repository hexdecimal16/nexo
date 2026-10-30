import { reviewQueue, type ReviewQueueItem } from "@nexo/store";
import { NexoError } from "@nexo/telemetry";
import type { ApiContext } from "./api.ts";

function positiveInt(params: URLSearchParams, name: string): number | undefined {
	const raw = params.get(name);
	if (raw === null || raw === "") return undefined;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 1) throw new NexoError({ code: "INVALID_REQUEST", message: `${name} must be a positive integer`, context: { [name]: raw } });
	return n;
}

/** `GET /api/review-queue?limit=&days=`: recent runs without a human verdict, worst first. */
export function reviewQueueResponse(ctx: ApiContext, params: URLSearchParams): { items: ReviewQueueItem[] } {
	const limit = positiveInt(params, "limit");
	const days = positiveInt(params, "days");
	const items = reviewQueue(ctx.db, { now: ctx.now(), ...(limit ? { limit } : {}), ...(days ? { days } : {}) });
	return { items: items.map((i) => ({ ...i, instruction: String(ctx.redact(i.instruction)) })) };
}
