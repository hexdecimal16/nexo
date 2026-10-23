// What nex offers on each page: a label and suggested questions. Pure, so it is tested under vitest.

export type PageKey = "runs" | "run" | "cost" | "sessions" | "learning" | "judge" | "optim" | "wikis";

export interface PageContext {
	page: PageKey;
	label: string;
	runId: string | null;
	prompts: string[];
}

const BASE: Record<PageKey, { label: string; prompts: string[] }> = {
	runs: { label: "runs", prompts: ["Which runs failed recently, and why?", "What should I review first?"] },
	run: { label: "this run", prompts: ["Explain what happened in this run", "Why did it cost this much?", "What should I check before a verdict?"] },
	cost: { label: "cost", prompts: ["Where is the spend going?", "Which runs were unusually expensive?"] },
	sessions: { label: "sessions", prompts: ["Summarise my recent sessions"] },
	learning: { label: "learning", prompts: ["What has nexo learned lately?", "Is anything worth retiring?"] },
	judge: { label: "judge", prompts: ["How reliable is the judge?"] },
	optim: { label: "optimization", prompts: ["What is the status of my optimizations?", "Does anything need approval?"] },
	wikis: { label: "wikis", prompts: ["What is in my wikis?"] },
};

export function pageContext(pathname: string, search: string): PageContext {
	const file = pathname === "/" || pathname === "/index.html" ? "runs" : pathname.replace(/^\/+/, "").replace(/\.html$/, "");
	let page: PageKey = Object.hasOwn(BASE, file) ? (file as PageKey) : "runs";
	const id = new URLSearchParams(search).get("id") ?? "";
	const runId = page === "run" && /^[0-9A-Za-z]{1,64}$/.test(id) ? id : null;
	if (page === "run" && runId === null) page = "runs";
	const { label, prompts } = BASE[page];
	return { page, label, runId, prompts };
}
