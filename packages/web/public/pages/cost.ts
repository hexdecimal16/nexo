import type { CostResponse, MetaResponse } from "../lib/api-types.ts";
import { renderError } from "../lib/common-view.ts";
import { costQuery, renderCostTable, renderDimensionOptions } from "../lib/cost-view.ts";
import { asErrorBody, el, getJson } from "./api.ts";

const form = el<HTMLFormElement>("#cost-form");
const by = el<HTMLSelectElement>("#cost-by");
const out = el<HTMLElement>("#cost-table");

async function load(): Promise<void> {
	const data = new FormData(form);
	try {
		const report = await getJson<CostResponse>(costQuery(String(data.get("by") ?? ""), String(data.get("since") ?? "")));
		out.innerHTML = renderCostTable(report).value;
	} catch (error) {
		out.innerHTML = renderError(asErrorBody(error)).value;
	}
}

async function init(): Promise<void> {
	try {
		const meta = await getJson<MetaResponse>("/api/meta");
		by.innerHTML = renderDimensionOptions(meta.costDimensions, "day").value;
	} catch (error) {
		out.innerHTML = renderError(asErrorBody(error)).value;
		return;
	}
	await load();
}

form.addEventListener("submit", (event) => {
	event.preventDefault();
	void load();
});
form.addEventListener("change", () => void load());
void init();
