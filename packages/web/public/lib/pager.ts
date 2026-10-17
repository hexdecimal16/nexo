import { html, type SafeHtml } from "./html.ts";

export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

/** The page a list shows: rows skipped and rows per page. */
export interface Page {
	offset: number;
	limit: number;
}

export interface PageState extends Page {
	/** Rows across every page, from the API. */
	total: number;
}

export function pageCount(total: number, limit: number): number {
	return Math.max(1, Math.ceil(total / limit));
}

/** Up to seven slots: every page of a short table; otherwise the first and last pages, the current one with its neighbours, and null for each gap. */
export function pageNumbers(current: number, count: number): (number | null)[] {
	if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
	if (current <= 4) return [1, 2, 3, 4, 5, null, count];
	if (current >= count - 3) return [1, null, count - 4, count - 3, count - 2, count - 1, count];
	return [1, null, current - 1, current, current + 1, null, count];
}

/** Adds the page to query parameters: `limit` always, `offset` past the first page. */
export function pageParams(page: Page, params: URLSearchParams = new URLSearchParams()): URLSearchParams {
	params.set("limit", String(page.limit));
	if (page.offset > 0) params.set("offset", String(page.offset));
	return params;
}

/**
 * Page controls under a table: the row range, Previous, the page numbers, Next and the rows-per-page choice. Buttons carry
 * `data-page-offset`; the select carries `data-page-size` (see pages/paging.ts). Empty for a table without rows.
 */
export function renderPager(page: PageState): SafeHtml {
	if (page.total === 0) return html``;
	const count = pageCount(page.total, page.limit);
	const current = Math.min(count, Math.floor(page.offset / page.limit) + 1);
	const first = (current - 1) * page.limit;
	const button = (offset: number, label: string, extra: SafeHtml | string, disabled: boolean): SafeHtml =>
		html`<button type="button" data-page-offset="${offset}"${extra}${disabled ? html` disabled` : ""}>${label}</button>`;
	return html`<nav class="pager" aria-label="Pages">
	<span class="pager-range">${first + 1}–${Math.min(page.total, first + page.limit)} of ${page.total}</span>
	${button(Math.max(0, first - page.limit), "‹ Prev", html` aria-label="Previous page"`, current === 1)}
	${pageNumbers(current, count).map((n) =>
		n === null ? html`<span class="pager-gap">…</span>` : button((n - 1) * page.limit, String(n), n === current ? html` aria-current="page"` : "", false),
	)}
	${button(first + page.limit, "Next ›", html` aria-label="Next page"`, current === count)}
	<label>Rows per page <select data-page-size>${PAGE_SIZES.map((s) => html`<option value="${s}"${s === page.limit ? html` selected` : ""}>${s}</option>`)}</select></label>
</nav>`;
}
