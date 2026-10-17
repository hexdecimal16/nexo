import type { SessionListResponse } from "../lib/api-types.ts";
import { renderError } from "../lib/common-view.ts";
import { DEFAULT_PAGE_SIZE, type Page, renderPager } from "../lib/pager.ts";
import { renderSessionRows, sessionsQuery } from "../lib/sessions-view.ts";
import { asErrorBody, el, getJson } from "./api.ts";
import { bindPager } from "./paging.ts";

const body = el<HTMLTableSectionElement>("#sessions-body");
const pager = el<HTMLDivElement>("#pager");
const errorBox = el<HTMLDivElement>("#error");
const page: Page = { offset: 0, limit: DEFAULT_PAGE_SIZE };

async function load(): Promise<void> {
	errorBox.innerHTML = "";
	try {
		const result = await getJson<SessionListResponse>(sessionsQuery(page));
		body.innerHTML = renderSessionRows(result.sessions).value;
		pager.innerHTML = renderPager({ ...page, total: result.total ?? result.sessions.length }).value;
	} catch (error) {
		errorBox.innerHTML = renderError(asErrorBody(error)).value;
	}
}

bindPager(pager, page, () => void load());
void load();
