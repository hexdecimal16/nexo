import type { EvalCasesResponse, MetaResponse, OptimDetailResponse, OptimListResponse } from "../lib/api-types.ts";
import { renderError } from "../lib/common-view.ts";
import { optimQuery, renderOptimDetail, renderOptimList, renderProposedCases } from "../lib/optim-view.ts";
import { DEFAULT_PAGE_SIZE, type Page, renderPager } from "../lib/pager.ts";
import { asErrorBody, el, getJson, postJson } from "./api.ts";
import { bindPager } from "./paging.ts";

const errorBox = el<HTMLDivElement>("#error");
const listBox = el<HTMLDivElement>("#optim-runs");
const listPager = el<HTMLDivElement>("#pager");
const proposedBox = el<HTMLDivElement>("#eval-proposed");
const detailBox = el<HTMLDivElement>("#optim-detail");

let readOnly = false;
const page: Page = { offset: 0, limit: DEFAULT_PAGE_SIZE };

function showError(error: unknown): void {
	errorBox.innerHTML = renderError(asErrorBody(error)).value;
}

/** Loads and renders the current page of optimizations. */
async function loadList(): Promise<void> {
	const result = await getJson<OptimListResponse>(optimQuery(page));
	listBox.innerHTML = renderOptimList(result.runs).value;
	listPager.innerHTML = renderPager({ ...page, total: result.total ?? result.runs.length }).value;
}

async function loadProposed(): Promise<void> {
	proposedBox.innerHTML = renderProposedCases((await getJson<EvalCasesResponse>("/api/eval-cases?status=proposed")).cases, readOnly).value;
}

async function loadDetail(id: string): Promise<void> {
	const data = await getJson<OptimDetailResponse>(`/api/optim/${encodeURIComponent(id)}`);
	detailBox.innerHTML = renderOptimDetail(data, readOnly).value;
	if (location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`);
}

async function loadAll(): Promise<void> {
	errorBox.innerHTML = "";
	readOnly = (await getJson<MetaResponse>("/api/meta")).readOnly !== null;
	await loadProposed();
	await loadList();
	const id = location.hash.slice(1);
	if (/^[0-9A-Za-z]{1,64}$/.test(id)) await loadDetail(id);
}

document.addEventListener("click", (event) => {
	const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("button") : null;
	if (!target) return;
	const { optim, approve, accept, dismiss } = target.dataset;
	if (optim) {
		errorBox.innerHTML = "";
		loadDetail(optim).catch(showError);
	} else if (approve) {
		if (!window.confirm("Approve this candidate? It becomes the active version; the current one is retired (rollback: nexo optimize rollback).")) return;
		postJson(`/api/optim/${encodeURIComponent(approve)}/approve`, {})
			.then(() => Promise.all([loadList(), loadDetail(approve)]))
			.catch(showError);
	} else if (accept || dismiss) {
		const id = (accept ?? dismiss) as string;
		postJson(`/api/eval-cases/${encodeURIComponent(id)}/${accept ? "accept" : "dismiss"}`, {})
			.then(loadProposed)
			.catch(showError);
	}
});

bindPager(listPager, page, () => loadList().catch(showError));
loadAll().catch(showError);
