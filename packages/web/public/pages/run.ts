import type {
	DirListing,
	FeedbackResponse,
	MetaResponse,
	ReadOnlyInfo,
	RunDetailResponse,
	SpanNode,
	SpanResponse,
	SpanTreeResponse,
} from "../lib/api-types.ts";
import { renderError } from "../lib/common-view.ts";
import { filePath, renderFile, renderListing } from "../lib/files-view.ts";
import { html, type SafeHtml } from "../lib/html.ts";
import { createPoller } from "../lib/poller.ts";
import { renderChildren, renderFeedbackForm, renderRunHeader, shouldPoll } from "../lib/run-view.ts";
import { findSpan, renderSpanDetail, renderSpanTree } from "../lib/span-view.ts";
import { renderTimeline, timelineRows } from "../lib/timeline.ts";
import { asErrorBody, el, getJson, getText, postJson } from "./api.ts";

const runId = new URLSearchParams(location.search).get("id") ?? "";
const header = el<HTMLElement>("#header");
const review = el<HTMLElement>("#review");
const children = el<HTMLElement>("#children");
const timeline = el<HTMLElement>("#timeline");
const tree = el<HTMLElement>("#tree");
const detail = el<HTMLElement>("#span-detail");
const files = el<HTMLElement>("#files");
const fileView = el<HTMLElement>("#file-view");
const errorBox = el<HTMLDivElement>("#error");

let roots: SpanNode[] = [];
let filesLoaded = false;
let readOnly: ReadOnlyInfo | null | undefined;

/** What a refresh must not throw away: expanded span-tree nodes, unsent verdict forms and the focused comment box. */
interface ViewState {
	open: Map<string, boolean>;
	forms: Map<string, { verdict: string; comment: string }>;
	focus: { run: string; start: number; end: number } | null;
}

function summarySpanId(details: HTMLDetailsElement): string | undefined {
	return details.querySelector<HTMLElement>(":scope > summary")?.dataset.spanId;
}

function captureState(): ViewState {
	const open = new Map<string, boolean>();
	for (const details of tree.querySelectorAll<HTMLDetailsElement>("details")) {
		const id = summarySpanId(details);
		if (id) open.set(id, details.open);
	}
	const forms = new Map<string, { verdict: string; comment: string }>();
	for (const form of document.querySelectorAll<HTMLFormElement>("form[data-feedback-run]")) {
		const data = new FormData(form);
		forms.set(form.dataset.feedbackRun ?? "", { verdict: String(data.get("verdict") ?? ""), comment: String(data.get("comment") ?? "") });
	}
	const active = document.activeElement;
	const focusRun = active instanceof HTMLTextAreaElement ? active.form?.dataset.feedbackRun : undefined;
	const focus = focusRun && active instanceof HTMLTextAreaElement ? { run: focusRun, start: active.selectionStart, end: active.selectionEnd } : null;
	return { open, forms, focus };
}

function restoreState(state: ViewState): void {
	for (const details of tree.querySelectorAll<HTMLDetailsElement>("details")) {
		const id = summarySpanId(details);
		const wasOpen = id === undefined ? undefined : state.open.get(id);
		if (wasOpen !== undefined) details.open = wasOpen;
	}
	for (const form of document.querySelectorAll<HTMLFormElement>("form[data-feedback-run]")) {
		const run = form.dataset.feedbackRun ?? "";
		const saved = state.forms.get(run);
		const comment = form.querySelector<HTMLTextAreaElement>("textarea[name=comment]");
		if (saved) {
			if (comment) comment.value = saved.comment;
			for (const radio of form.querySelectorAll<HTMLInputElement>("input[name=verdict]")) radio.checked = radio.value === saved.verdict;
		}
		if (comment && state.focus?.run === run && document.activeElement !== comment) {
			comment.focus();
			comment.setSelectionRange(state.focus.start, state.focus.end);
		}
	}
}

const rendered = new WeakMap<HTMLElement, string>();

/** Replaces a region only when its markup changed, so an unchanged form keeps its DOM, focus and typed text. */
function setHtml(target: HTMLElement, markup: SafeHtml): void {
	if (rendered.get(target) === markup.value) return;
	target.innerHTML = markup.value;
	rendered.set(target, markup.value);
}

function showError(error: unknown, target: HTMLElement = errorBox): void {
	target.innerHTML = renderError(asErrorBody(error)).value;
}

async function loadDir(path: string): Promise<void> {
	try {
		files.innerHTML = renderListing(await getJson<DirListing>(filePath(runId, path))).value;
	} catch (error) {
		showError(error, files);
	}
}

async function loadFile(fileRunId: string, path: string, full = false): Promise<void> {
	try {
		const { text, truncatedSize } = await getText(filePath(fileRunId, path, full));
		fileView.innerHTML = renderFile(path, text, truncatedSize).value;
		fileView.dataset.run = fileRunId;
		fileView.scrollIntoView({ block: "nearest" });
	} catch (error) {
		showError(error, fileView);
	}
}

/** Loads and renders the run once; resolves true while the run is still running. */
async function load(): Promise<boolean> {
	const [run, spans, meta] = await Promise.all([
		getJson<RunDetailResponse>(`/api/runs/${encodeURIComponent(runId)}`),
		getJson<SpanTreeResponse>(`/api/runs/${encodeURIComponent(runId)}/spans`),
		readOnly === undefined ? getJson<MetaResponse>("/api/meta") : Promise.resolve(null),
	]);
	if (meta) readOnly = meta.readOnly;
	const now = Date.now();
	const state = captureState();
	errorBox.innerHTML = "";
	document.title = `nexo · ${run.run.instruction.slice(0, 60)}`;
	setHtml(header, renderRunHeader(run, now));
	setHtml(review, renderFeedbackForm(run.run, run.feedback.at(-1), readOnly ?? null));
	setHtml(children, renderChildren(run.children, now, readOnly ?? null, run.childFeedback));
	roots = spans.roots;
	setHtml(timeline, renderTimeline(timelineRows(roots, now)));
	setHtml(tree, html`${spans.truncated ? html`<p class="warn">This run has ${spans.total} spans; only the earliest are shown.</p>` : ""}${renderSpanTree(roots, now)}`);
	restoreState(state);
	if (!filesLoaded && !run.dirMissing) {
		filesLoaded = true;
		await loadDir("");
	}
	return shouldPoll(run.run.status);
}

const poller = createPoller({
	task: load,
	onError: (error) => showError(error),
	setTimer: (callback, ms) => window.setTimeout(callback, ms),
	clearTimer: (handle) => window.clearTimeout(handle as number),
});

// Dataset values are decoded raw strings: they only reach lookups, encodeURIComponent or filePath, never markup.
document.addEventListener("click", (event) => {
	const target = (event.target as HTMLElement).closest<HTMLElement>("[data-span-id],[data-full-span],[data-dir],[data-file],[data-file-path],[data-file-full]");
	if (!target) return;
	const d = target.dataset;
	if (d.spanId !== undefined) {
		const node = findSpan(roots, d.spanId);
		if (node) detail.innerHTML = renderSpanDetail(node.span, node.attrsTruncated, Date.now()).value;
	} else if (d.fullSpan !== undefined) {
		getJson<SpanResponse>(`/api/runs/${encodeURIComponent(runId)}/spans/${encodeURIComponent(d.fullSpan)}`)
			.then((res) => (detail.innerHTML = renderSpanDetail(res.span, false, Date.now()).value))
			.catch((error: unknown) => showError(error, detail));
	} else if (d.dir !== undefined) {
		void loadDir(d.dir);
	} else if (d.file !== undefined) {
		void loadFile(runId, d.file);
	} else if (d.filePath !== undefined) {
		void loadFile(d.fileRun ?? runId, d.filePath);
	} else if (d.fileFull !== undefined) {
		void loadFile(fileView.dataset.run ?? runId, d.fileFull, true);
	}
});

document.addEventListener("submit", (event) => {
	const form = (event.target as HTMLElement).closest<HTMLFormElement>("form[data-feedback-run]");
	if (!form) return;
	event.preventDefault();
	const data = new FormData(form);
	const status = form.querySelector<HTMLElement>(".form-status");
	postJson<FeedbackResponse>(`/api/runs/${encodeURIComponent(form.dataset.feedbackRun ?? "")}/feedback`, {
		verdict: String(data.get("verdict") ?? ""),
		comment: String(data.get("comment") ?? ""),
	})
		.then(() => {
			form.reset();
			return poller.refresh();
		})
		.catch((error: unknown) => {
			if (status) status.innerHTML = renderError(asErrorBody(error)).value;
		});
});

if (runId) void poller.refresh();
else showError({ code: "INVALID_REQUEST", message: "No run id in the address", retryable: false });
