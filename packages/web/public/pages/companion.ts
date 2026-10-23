// nex, the nexo companion: an SVG character in the corner that reflects live run state (working, happy, worried,
// idle, sleepy), follows the pointer with its eyes, cheers or flinches when a run finishes, and opens a panel of
// quick actions. Press "." anywhere (outside a text field) to open it. Built with DOM APIs only: no inline style.
import type { RunListResponse } from "../lib/api-types.ts";
import { runLink } from "../lib/common-view.ts";
import { type CompanionState, deriveMood, MOUTHS, transitions } from "../lib/companion-mood.ts";
import { pageContext } from "../lib/companion-pages.ts";
import { asErrorBody, getJson, postJson } from "./api.ts";

interface AskResponse {
	answer: string;
	links: { label: string; href: string }[];
	steps: string[];
}

const NS = "http://www.w3.org/2000/svg";
const POLL_MS = 8000;
const STILL_KEY = "nexo-companion-still";

function svg(tag: string, attrs: Record<string, string>, parent: Element): SVGElement {
	const node = document.createElementNS(NS, tag);
	for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
	parent.append(node);
	return node;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: Element, text?: string): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	if (cls) el.className = cls;
	if (text !== undefined) el.textContent = text;
	parent.append(el);
	return el;
}

function readStill(): boolean {
	try {
		return localStorage.getItem(STILL_KEY) === "1";
	} catch {
		return false;
	}
}

// Root, character button and panel
const root = document.createElement("aside");
root.className = "nx";
root.dataset.mood = "idle";
root.setAttribute("aria-label", "nex, your nexo companion");

const panel = node("div", "nx-panel", root);
panel.id = "nx-panel";
panel.hidden = true;
node("div", "nx-name", panel, "nex");
const line = node("p", "nx-line", panel, "Waking up…");
line.setAttribute("aria-live", "polite");
const stats = node("dl", "nx-stats", panel);
const actions = node("ul", "nx-actions", panel);
// Ask nex: suggested questions for this page, a text box, and the answer. The server runs the small model with
// read-only tools; links in the answer are checked there and again here before they become anchors.
const here = pageContext(location.pathname, location.search);
const ask = node("form", "nx-ask", panel);
const chips = node("div", "nx-chips", ask);
for (const prompt of here.prompts) {
	const chip = node("button", "nx-chip", chips, prompt);
	chip.type = "button";
	chip.addEventListener("click", () => void submit(prompt));
}
const row = node("div", "nx-ask-row", ask);
const input = node("input", "", row);
input.type = "text";
input.maxLength = 500;
input.placeholder = `Ask nex about ${here.label}`;
input.setAttribute("aria-label", `Ask nex about ${here.label}`);
const send = node("button", "primary", row, "Ask");
send.type = "submit";
const reply = node("div", "nx-reply", panel);
reply.setAttribute("aria-live", "polite");

async function submit(question: string): Promise<void> {
	const q = question.trim();
	if (!q || send.disabled) return;
	send.disabled = true;
	root.classList.add("nx-thinking");
	reply.replaceChildren();
	node("p", "nx-answer muted", reply, "Thinking…");
	try {
		const result = await postJson<AskResponse>("/api/companion/ask", { page: here.page, runId: here.runId, question: q });
		reply.replaceChildren();
		node("p", "nx-answer", reply, result.answer);
		const safe = result.links.filter((l) => l.href.startsWith("/") && !l.href.startsWith("//"));
		if (safe.length > 0) {
			const list = node("ul", "nx-links", reply);
			for (const l of safe) node("a", "", node("li", "", list), l.label).href = l.href;
		}
		if (result.steps.length > 0) node("div", "nx-hint", reply, `looked at: ${result.steps.join(", ")}`);
	} catch (error) {
		reply.replaceChildren();
		const body = asErrorBody(error);
		node("p", "nx-answer", reply, body.code === "CONFIG_INVALID" ? `${body.message}. ${body.hint ?? ""}`.trim() : `I couldn't answer that: ${body.message}`);
	} finally {
		send.disabled = false;
		root.classList.remove("nx-thinking");
	}
}
ask.addEventListener("submit", (event) => {
	event.preventDefault();
	void submit(input.value);
	input.value = "";
});

const stillButton = node("button", "link nx-still-toggle", panel);
stillButton.type = "button";
node("div", "nx-hint", panel, "Press . to toggle, Esc to close");

const button = node("button", "nx-button", root);
button.type = "button";
button.setAttribute("aria-expanded", "false");
button.setAttribute("aria-controls", panel.id);

const face = svg("svg", { class: "nx-svg", viewBox: "0 0 64 64", "aria-hidden": "true", focusable: "false" }, button);
svg("circle", { class: "nx-orbit", cx: "32", cy: "36", r: "28" }, face);
const body = svg("g", { class: "nx-body" }, face);
svg("line", { class: "nx-antenna", x1: "32", y1: "15", x2: "36", y2: "7" }, body);
svg("circle", { class: "nx-spark", cx: "37", cy: "5.5", r: "3" }, body);
svg("path", { class: "nx-shell", d: "M32 14 C46 14 54 24 54 37 C54 49 44 54 32 54 C20 54 10 49 10 37 C10 24 18 14 32 14 Z" }, body);
svg("circle", { class: "nx-cheek", cx: "19", cy: "40", r: "3.2" }, body);
svg("circle", { class: "nx-cheek", cx: "45", cy: "40", r: "3.2" }, body);
const eyes = svg("g", { class: "nx-eyes" }, body);
svg("ellipse", { class: "nx-eye", cx: "25", cy: "33", rx: "3", ry: "4" }, eyes);
svg("ellipse", { class: "nx-eye", cx: "39", cy: "33", rx: "3", ry: "4" }, eyes);
const mouth = svg("path", { class: "nx-mouth", d: MOUTHS.idle }, body);
const zz = svg("text", { class: "nx-z", x: "48", y: "16" }, face);
zz.textContent = "z";

let still = readStill();
const applyStill = (): void => {
	root.classList.toggle("nx-still", still);
	stillButton.textContent = still ? "Let nex move again" : "Keep nex still";
};
stillButton.addEventListener("click", () => {
	still = !still;
	try {
		if (still) localStorage.setItem(STILL_KEY, "1");
		else localStorage.removeItem(STILL_KEY);
	} catch {
		// Storage can be unavailable; the choice then lasts for this page only.
	}
	applyStill();
});
applyStill();

// Opening and closing
const setOpen = (open: boolean, focusBack = false): void => {
	panel.hidden = !open;
	button.setAttribute("aria-expanded", String(open));
	if (!open && focusBack) button.focus();
};
button.addEventListener("click", () => setOpen(panel.hidden));
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && !panel.hidden) return setOpen(false, true);
	if (event.key !== "." || event.metaKey || event.ctrlKey || event.altKey) return;
	const target = event.target as HTMLElement | null;
	if (target?.closest("input, textarea, select, [contenteditable]")) return;
	event.preventDefault();
	setOpen(panel.hidden);
	if (!panel.hidden) button.focus();
});
document.addEventListener("click", (event) => {
	if (!panel.hidden && !root.contains(event.target as Node)) setOpen(false);
});

// Eyes follow the pointer, a few px at most; skipped when motion is reduced or nex is kept still.
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
let frame = 0;
document.addEventListener("pointermove", (event) => {
	if (reduced.matches || still || frame) return;
	frame = requestAnimationFrame(() => {
		frame = 0;
		const box = face.getBoundingClientRect();
		const dx = event.clientX - (box.left + box.width / 2);
		const dy = event.clientY - (box.top + box.height / 2);
		const len = Math.hypot(dx, dy) || 1;
		const reach = Math.min(2.5, len / 60);
		eyes.setAttribute("transform", `translate(${((dx / len) * reach).toFixed(2)} ${((dy / len) * reach).toFixed(2)})`);
	});
});

// Rendering one state
function stat(term: string, value: string): void {
	node("dt", "", stats, term);
	node("dd", "", stats, value);
}

function action(label: string, href: string): void {
	const li = node("li", "", actions);
	const a = node("a", "", li, label);
	a.href = href;
}

function react(cls: "nx-cheer" | "nx-flinch"): void {
	root.classList.remove("nx-cheer", "nx-flinch");
	void root.getBoundingClientRect(); // restart the animation
	root.classList.add(cls);
	setTimeout(() => root.classList.remove(cls), 1600);
}

function render(state: CompanionState, reviewCount: number): void {
	root.dataset.mood = state.mood;
	mouth.setAttribute("d", MOUTHS[state.mood]);
	line.textContent = state.line;
	button.setAttribute("aria-label", `nex (${state.mood}): ${state.line} Activate for quick actions.`);
	button.title = state.line;

	stats.replaceChildren();
	stat("running", String(state.running.length));
	stat("to review", String(reviewCount));
	if (state.latest) stat("last run", `${state.latest.status.replace("_", " ")} · ${state.latest.modelFinal ?? "–"}`);

	actions.replaceChildren();
	const first = state.running[0];
	if (first) action(state.running.length > 1 ? `Watch the oldest of ${state.running.length} running runs` : "Watch the running run", runLink(first.id));
	if (state.lastFailed) action("Open the last failure", runLink(state.lastFailed.id));
	if (reviewCount > 0) action(`Review queue (${reviewCount})`, "/?tab=review");
	if (state.latest && state.latest !== state.lastFailed) action("Open the latest run", runLink(state.latest.id));
	action("Where the money went", "/cost.html");
}

// Polling, paused while the tab is hidden
let previousRunning = new Set<string>();
let first = true;
let timer = 0;

async function tick(): Promise<void> {
	clearTimeout(timer);
	if (!document.hidden) {
		try {
			const [recent, review] = await Promise.all([
				getJson<RunListResponse>("/api/runs?limit=25"),
				getJson<RunListResponse>("/api/runs?reviewed=false&limit=1"),
			]);
			const state = deriveMood(recent.runs, Date.now());
			if (!first) {
				const moved = transitions(previousRunning, recent.runs);
				if (moved.failed > 0) react("nx-flinch");
				else if (moved.succeeded > 0) react("nx-cheer");
			}
			first = false;
			previousRunning = new Set(state.running.map((r) => r.id));
			render(state, review.total ?? 0);
		} catch {
			root.dataset.mood = "sleepy";
			mouth.setAttribute("d", MOUTHS.sleepy);
			line.textContent = "I can't reach the nexo server right now. I'll keep trying.";
		}
	}
	timer = window.setTimeout(() => void tick(), POLL_MS);
}

document.addEventListener("visibilitychange", () => {
	if (!document.hidden) void tick();
});
document.body.append(root);
void tick();

export {};
