import type { SessionListResponse } from "../lib/api-types.ts";
import { renderError } from "../lib/common-view.ts";
import { renderSessionRows, renderSessionsLimitNote } from "../lib/sessions-view.ts";
import { asErrorBody, el, getJson } from "./api.ts";

const LIMIT = 200;
const body = el<HTMLTableSectionElement>("#sessions-body");
const noteBox = el<HTMLDivElement>("#limit-note");
const errorBox = el<HTMLDivElement>("#error");

async function load(): Promise<void> {
	errorBox.innerHTML = "";
	try {
		const { sessions } = await getJson<SessionListResponse>(`/api/sessions?limit=${LIMIT}`);
		body.innerHTML = renderSessionRows(sessions).value;
		noteBox.innerHTML = renderSessionsLimitNote(sessions.length, LIMIT).value;
	} catch (error) {
		errorBox.innerHTML = renderError(asErrorBody(error)).value;
	}
}

void load();
