import type { Page } from "../lib/pager.ts";

/** Wires a pager container: page buttons set the offset, the rows-per-page select goes back to the first page; `reload` re-renders. */
export function bindPager(container: HTMLElement, page: Page, reload: () => void): void {
	container.addEventListener("click", (event) => {
		const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-page-offset]");
		if (!button || button.disabled) return;
		page.offset = Number(button.dataset.pageOffset);
		reload();
	});
	container.addEventListener("change", (event) => {
		const select = (event.target as HTMLElement).closest<HTMLSelectElement>("select[data-page-size]");
		if (!select) return;
		page.limit = Number(select.value);
		page.offset = 0;
		reload();
	});
}
