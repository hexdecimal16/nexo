import type { MetaResponse, RunListResponse } from "../lib/api-types.ts";
import { renderError } from "../lib/common-view.ts";
import { type RunFilters, renderEmptyRuns, renderRunRows, renderRunsNote, renderSessionFilter, renderStatusOptions, runsQuery } from "../lib/runs-view.ts";
import { asErrorBody, el, getJson } from "./api.ts";

const filters: RunFilters = { tab: "all", status: "", skill: "", since: "", session: new URLSearchParams(location.search).get("session") ?? "", scored: "" };
let cursor: string | null = null;

const body = el<HTMLTableSectionElement>("#runs-body");
const more = el<HTMLButtonElement>("#load-more");
const errorBox = el<HTMLDivElement>("#error");
const form = el<HTMLFormElement>("#filters");
const statusFilter = el<HTMLSelectElement>("#status-filter");
const sessionFilter = el<HTMLDivElement>("#session-filter");

async function load(append: boolean): Promise<void> {
	errorBox.innerHTML = "";
	try {
		const page = await getJson<RunListResponse>(runsQuery(filters, append ? cursor : null));
		const rows = page.runs.length === 0 && !append ? renderEmptyRuns(filters.tab) : renderRunRows(page.runs, Date.now());
		if (append) body.insertAdjacentHTML("beforeend", rows.value);
		else body.innerHTML = rows.value;
		if (!append) sessionFilter.innerHTML = `${renderSessionFilter(filters.session, page.runs[0]?.sessionTitle ?? null).value}${renderRunsNote(filters).value}`;
		cursor = page.nextCursor;
		more.hidden = cursor === null;
	} catch (error) {
		errorBox.innerHTML = renderError(asErrorBody(error)).value;
	}
}

async function loadStatuses(): Promise<void> {
	try {
		const meta = await getJson<MetaResponse>("/api/meta");
		statusFilter.innerHTML = renderStatusOptions(meta.runStatuses, filters.status).value;
	} catch (error) {
		errorBox.innerHTML = renderError(asErrorBody(error)).value;
	}
}

for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
	tab.addEventListener("click", () => {
		filters.tab = tab.dataset.tab === "review" ? "review" : "all";
		for (const t of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) t.setAttribute("aria-selected", String(t === tab));
		void load(false);
	});
}

form.addEventListener("submit", (event) => {
	event.preventDefault();
	const data = new FormData(form);
	filters.status = String(data.get("status") ?? "");
	filters.skill = String(data.get("skill") ?? "");
	filters.since = String(data.get("since") ?? "");
	filters.scored = String(data.get("scored") ?? "");
	void load(false);
});

more.addEventListener("click", () => void load(true));
void loadStatuses();
void load(false);
