import type { SessionListItem, SessionListResponse } from "../lib/api-types.ts";
import { renderError } from "../lib/common-view.ts";
import { renderSessionRows, sessionsQuery } from "../lib/sessions-view.ts";
import { asErrorBody, el, getJson } from "./api.ts";

const body = el<HTMLTableSectionElement>("#sessions-body");
const more = el<HTMLButtonElement>("#load-more");
const errorBox = el<HTMLDivElement>("#error");

const loaded: SessionListItem[] = [];
let cursor: string | null = null;

/** Loads the first page, or with `append` the page after the last one, and renders everything loaded so far. */
async function load(append: boolean): Promise<void> {
	errorBox.innerHTML = "";
	try {
		const page = await getJson<SessionListResponse>(sessionsQuery(append ? cursor : null));
		if (!append) loaded.length = 0;
		loaded.push(...page.sessions);
		body.innerHTML = renderSessionRows(loaded).value;
		cursor = page.nextCursor ?? null;
		more.hidden = cursor === null;
	} catch (error) {
		errorBox.innerHTML = renderError(asErrorBody(error)).value;
	}
}

more.addEventListener("click", () => {
	if (cursor !== null) void load(true);
});
void load(false);
