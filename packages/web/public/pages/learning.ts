import type { LearnJob, LearnJobsResponse, Memory, MemoryDetailResponse, MemoryListResponse, MetaResponse, PlaybookListResponse, PlaybookResponse } from "../lib/api-types.ts";
import { renderError } from "../lib/common-view.ts";
import { jobsQuery, memoriesQuery, renderJobs, renderMemories, renderMemoryHistory, renderPlaybook, renderPlaybookList } from "../lib/learning-view.ts";
import { asErrorBody, el, getJson, postJson } from "./api.ts";

const errorBox = el<HTMLDivElement>("#error");
const filters = el<HTMLFormElement>("#memory-filters");
const memoriesBox = el<HTMLDivElement>("#memories");
const memoriesMore = el<HTMLButtonElement>("[data-more=memories]");
const historyBox = el<HTMLDivElement>("#memory-history");
const playbooksBox = el<HTMLDivElement>("#playbooks");
const playbookBox = el<HTMLDivElement>("#playbook");
const jobsBox = el<HTMLDivElement>("#jobs");
const jobsMore = el<HTMLButtonElement>("[data-more=jobs]");

let readOnly = false;
let openSkill: string | null = null;
/** Everything loaded so far and the cursor of the page after it, per paged table. */
const memories: { items: Memory[]; cursor: string | null } = { items: [], cursor: null };
const jobs: { items: LearnJob[]; cursor: string | null; counts: LearnJobsResponse["counts"] } = { items: [], cursor: null, counts: { pending: 0, running: 0, succeeded: 0, failed: 0 } };

function showError(error: unknown): void {
	errorBox.innerHTML = renderError(asErrorBody(error)).value;
}

/** Loads the first page of memories for the current filters, or with `append` the page after the last one. */
async function loadMemories(append = false): Promise<void> {
	const form = new FormData(filters);
	const data = await getJson<MemoryListResponse>(memoriesQuery(String(form.get("scope") ?? ""), String(form.get("type") ?? ""), form.get("all") === "on", append ? memories.cursor : null));
	if (!append) memories.items.length = 0;
	memories.items.push(...data.memories);
	memories.cursor = data.nextCursor ?? null;
	memoriesBox.innerHTML = renderMemories(memories.items, readOnly).value;
	memoriesMore.hidden = memories.cursor === null;
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

async function loadJobs(append = false): Promise<void> {
	const data = await getJson<LearnJobsResponse>(jobsQuery(append ? jobs.cursor : null));
	if (!append) jobs.items.length = 0;
	jobs.items.push(...data.jobs);
	jobs.cursor = data.nextCursor ?? null;
	jobs.counts = data.counts;
	jobsBox.innerHTML = renderJobs({ counts: jobs.counts, jobs: jobs.items, nextCursor: jobs.cursor }).value;
	jobsMore.hidden = jobs.cursor === null;
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
	const { retireMemory, memoryHistory, playbook, retireItem, skill, more } = target.dataset;
	if (more === "memories") {
		if (memories.cursor !== null) loadMemories(true).catch(showError);
	} else if (more === "jobs") {
		if (jobs.cursor !== null) loadJobs(true).catch(showError);
	} else if (retireMemory) {
		if (!window.confirm("Retire this memory? Runs stop seeing it; it stays in the history.")) return;
		postJson(`/api/memories/${encodeURIComponent(retireMemory)}/retire`, {})
			.then(() => loadMemories())
			.catch(showError);
	} else if (memoryHistory) {
		getJson<MemoryDetailResponse>(`/api/memories/${encodeURIComponent(memoryHistory)}`)
			.then((data) => {
				historyBox.innerHTML = renderMemoryHistory(data.memory, data.history).value;
				historyBox.scrollIntoView({ block: "nearest" });
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
