import type { SessionListResponse } from "../lib/api-types.ts";
import { renderError } from "../lib/common-view.ts";
import { renderSessionRows } from "../lib/sessions-view.ts";
import { asErrorBody, el, getJson } from "./api.ts";

const body = el<HTMLTableSectionElement>("#sessions-body");
const errorBox = el<HTMLDivElement>("#error");

async function load(): Promise<void> {
	errorBox.innerHTML = "";
	try {
		body.innerHTML = renderSessionRows((await getJson<SessionListResponse>("/api/sessions?limit=200")).sessions).value;
	} catch (error) {
		errorBox.innerHTML = renderError(asErrorBody(error)).value;
	}
}

void load();
