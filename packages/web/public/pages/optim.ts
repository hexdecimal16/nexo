import type { EvalCasesResponse, MetaResponse, OptimDetailResponse, OptimListResponse } from "../lib/api-types.ts";
import { renderError } from "../lib/common-view.ts";
import { renderOptimDetail, renderOptimList, renderProposedCases } from "../lib/optim-view.ts";
import { asErrorBody, el, getJson, postJson } from "./api.ts";

const errorBox = el<HTMLDivElement>("#error");
const listBox = el<HTMLDivElement>("#optim-runs");
const proposedBox = el<HTMLDivElement>("#eval-proposed");
const detailBox = el<HTMLDivElement>("#optim-detail");

let readOnly = false;

function showError(error: unknown): void {
	errorBox.innerHTML = renderError(asErrorBody(error)).value;
}

async function loadList(): Promise<void> {
	listBox.innerHTML = renderOptimList((await getJson<OptimListResponse>("/api/optim")).runs).value;
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

loadAll().catch(showError);
