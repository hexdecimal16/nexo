import type { MetaResponse, RunListResponse } from "../lib/api-types.ts";
import { renderError } from "../lib/common-view.ts";
import { DEFAULT_PAGE_SIZE, type Page, renderPager } from "../lib/pager.ts";
import { type RunFilters, readRunFilters, renderEmptyRuns, renderRunRows, renderRunsNote, renderSessionFilter, renderStatusOptions, runsPageSearch, runsQuery } from "../lib/runs-view.ts";
import { asErrorBody, el, getJson } from "./api.ts";
import { bindPager } from "./paging.ts";

const filters: RunFilters = readRunFilters(location.search);
const page: Page = { offset: 0, limit: DEFAULT_PAGE_SIZE };

const body = el<HTMLTableSectionElement>("#runs-body");
const pager = el<HTMLDivElement>("#pager");
const errorBox = el<HTMLDivElement>("#error");
const form = el<HTMLFormElement>("#filters");
const statusFilter = el<HTMLSelectElement>("#status-filter");
const sessionFilter = el<HTMLDivElement>("#session-filter");

/** Loads and renders the current page of the current tab and filters. */
async function load(): Promise<void> {
	errorBox.innerHTML = "";
	try {
		const result = await getJson<RunListResponse>(runsQuery(filters, page));
		body.innerHTML = (result.runs.length === 0 ? renderEmptyRuns(filters.tab) : renderRunRows(result.runs, Date.now())).value;
		sessionFilter.innerHTML = `${renderSessionFilter(filters.session, result.runs[0]?.sessionTitle ?? null).value}${renderRunsNote(filters).value}`;
		pager.innerHTML = renderPager({ ...page, total: result.total ?? result.runs.length }).value;
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

function showTab(): void {
	for (const t of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
	const selected = (t.dataset.tab === "review" ? "review" : "all") === filters.tab;
	t.setAttribute("aria-selected", String(selected));
	t.tabIndex = selected ? 0 : -1;
}
	const search = runsPageSearch(filters);
	if (location.search !== search) history.replaceState(null, "", `${location.pathname}${search}`);
}

for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
	tab.addEventListener("click", () => {
		filters.tab = tab.dataset.tab === "review" ? "review" : "all";
		page.offset = 0;
		showTab();
		void load();
	});
}

// Arrow keys move between tabs (roving tabindex), as the tab role promises.
const tabButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-tab]")];
for (const tab of tabButtons) {
	tab.addEventListener("keydown", (event) => {
		const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
		if (step === 0) return;
		event.preventDefault();
		const next = tabButtons[(tabButtons.indexOf(tab) + step + tabButtons.length) % tabButtons.length];
		next?.focus();
		next?.click();
	});
}

form.addEventListener("submit", (event) => {
	event.preventDefault();
	const data = new FormData(form);
	filters.status = String(data.get("status") ?? "");
	filters.skill = String(data.get("skill") ?? "");
	filters.since = String(data.get("since") ?? "");
	filters.scored = String(data.get("scored") ?? "");
	page.offset = 0;
	void load();
});

// Selects and the date apply as soon as they change; the skill text field waits for Enter or Apply.
form.addEventListener("change", (event) => {
	if (event.target instanceof HTMLSelectElement || (event.target instanceof HTMLInputElement && event.target.type === "date")) form.requestSubmit();
});

bindPager(pager, page, () => void load());
showTab();
void loadStatuses();
void load();
