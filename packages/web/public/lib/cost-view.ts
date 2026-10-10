import type { CostDimension, CostResponse } from "./api-types.ts";
import { formatUsd } from "./format.ts";
import { html, type SafeHtml } from "./html.ts";

/** API path for a cost report; an empty `by` or `since` leaves the server default (day, last 30 days). */
export function costQuery(by: string, since: string): string {
	const params = new URLSearchParams();
	if (by) params.set("by", by);
	if (since) params.set("since", since);
	const query = params.toString();
	return query ? `/api/costs?${query}` : "/api/costs";
}

/** `<option>`s for the group-by select, from the dimensions in `/api/meta`. */
export function renderDimensionOptions(dimensions: readonly CostDimension[], selected: string): SafeHtml {
	return html`${dimensions.map((d) => html`<option value="${d}"${d === selected ? html` selected` : ""}>${d}</option>`)}`;
}

export function renderCostTable(report: CostResponse): SafeHtml {
	const max = Math.max(0, ...report.rows.map((r) => r.costUsd));
	return html`${report.unknownCalls > 0 ? html`<p class="warn" role="alert">${report.unknownCalls} LLM call${report.unknownCalls === 1 ? " has" : "s have"} no price. Totals leave them out; add pricingOverrides to your nexo config to price them.</p>` : ""}
<table class="costs">
	<thead><tr><th>${report.by}</th><th class="num">cost</th><th></th><th class="num">calls</th><th class="num">unpriced</th></tr></thead>
	<tbody>${report.rows.length === 0 ? html`<tr><td colspan="5" class="empty">No LLM calls since ${report.since}.</td></tr>` : ""}${report.rows.map(
		(row) => html`<tr${row.unknownCalls ? html` class="warn"` : ""}>
		<td class="mono">${row.key}</td>
		<td class="num">${formatUsd(row.costUsd)}</td>
		<td class="bar-cell"><svg class="cost-bar" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect x="0" y="0" height="6" width="${max > 0 ? ((row.costUsd / max) * 100).toFixed(1) : "0"}"></rect></svg></td>
		<td class="num">${row.calls}</td>
		<td class="num">${row.unknownCalls || ""}</td>
	</tr>`,
	)}</tbody>
	<tfoot><tr><th>total since ${report.since}</th><th class="num">${formatUsd(report.totalUsd, report.unknownCalls > 0)}</th><th></th><th></th><th class="num">${report.unknownCalls || ""}</th></tr></tfoot>
</table>`;
}
