import type { LearnJobsResponse, MemoryDetailResponse, MemoryListResponse, MetaResponse, PlaybookListResponse, PlaybookResponse } from "../lib/api-types.ts";
import { renderError } from "../lib/common-view.ts";
import { memoriesQuery, renderJobs, renderMemories, renderMemoryHistory, renderPlaybook, renderPlaybookList } from "../lib/learning-view.ts";
import { asErrorBody, el, getJson, postJson } from "./api.ts";

const errorBox = el<HTMLDivElement>("#error");
const filters = el<HTMLFormElement>("#memory-filters");
const memoriesBox = el<HTMLDivElement>("#memories");
const historyBox = el<HTMLDivElement>("#memory-history");
const playbooksBox = el<HTMLDivElement>("#playbooks");
const playbookBox = el<HTMLDivElement>("#playbook");
const jobsBox = el<HTMLDivElement>("#jobs");

let readOnly = false;
let openSkill: string | null = null;

function showError(error: unknown): void {
	errorBox.innerHTML = renderError(asErrorBody(error)).value;
}

async function loadMemories(): Promise<void> {
	const form = new FormData(filters);
	const data = await getJson<MemoryListResponse>(memoriesQuery(String(form.get("scope") ?? ""), String(form.get("type") ?? ""), form.get("all") === "on"));
	memoriesBox.innerHTML = renderMemories(data.memories, readOnly).value;
}

async function loadPlaybooks(): Promise<void> {
	playbooksBox.innerHTML = renderPlaybookList(await getJson<PlaybookListResponse>("/api/playbooks")).value;
	if (openSkill) await loadPlaybook(openSkill);
}

async function loadPlaybook(skill: string): Promise<void> {
	openSkill = skill;
	const data = await getJson<PlaybookResponse>(`/api/playbooks/${encodeURIComponent(skill)}?all=1`);
	playbookBox.innerHTML = renderPlaybook(data, readOnly).value;
}

async function loadJobs(): Promise<void> {
	jobsBox.innerHTML = renderJobs(await getJson<LearnJobsResponse>("/api/learn/jobs?limit=20")).value;
}

async function loadAll(): Promise<void> {
	errorBox.innerHTML = "";
	readOnly = (await getJson<MetaResponse>("/api/meta")).readOnly !== null;
	await Promise.all([loadMemories(), loadPlaybooks(), loadJobs()]);
}

filters.addEventListener("submit", (event) => {
	event.preventDefault();
	loadMemories().catch(showError);
});

document.addEventListener("click", (event) => {
	const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("button") : null;
	if (!target) return;
	const { retireMemory, memoryHistory, playbook, retireItem, skill } = target.dataset;
	if (retireMemory) {
		if (!window.confirm("Retire this memory? Runs stop seeing it; it stays in the history.")) return;
		postJson(`/api/memories/${encodeURIComponent(retireMemory)}/retire`, {})
			.then(() => loadMemories())
			.catch(showError);
	} else if (memoryHistory) {
		getJson<MemoryDetailResponse>(`/api/memories/${encodeURIComponent(memoryHistory)}`)
			.then((data) => {
				historyBox.innerHTML = renderMemoryHistory(data.history).value;
			})
			.catch(showError);
	} else if (playbook) {
		loadPlaybook(playbook).catch(showError);
	} else if (retireItem && skill) {
		if (!window.confirm(`Retire ${skill}/${retireItem}? The next playbook version leaves it out.`)) return;
		postJson(`/api/playbooks/${encodeURIComponent(skill)}/items/${encodeURIComponent(retireItem)}/retire`, {})
			.then(() => loadPlaybooks())
			.catch(showError);
	}
});

loadAll().catch(showError);
