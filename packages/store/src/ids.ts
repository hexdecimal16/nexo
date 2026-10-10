import { monotonicFactory } from "ulid";

const nextUlid = monotonicFactory();

/** Time-sortable unique id (ULID) used for runs, spans and artifacts. */
export function newId(): string {
	return nextUlid();
}
