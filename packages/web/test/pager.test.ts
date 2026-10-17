import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_SIZE, PAGE_SIZES, pageNumbers, renderPager } from "../public/lib/pager.ts";

describe("pager", () => {
	it("lists every page of a short table and seven slots with gaps for a long one", () => {
		expect(pageNumbers(1, 1)).toEqual([1]);
		expect(pageNumbers(1, 5)).toEqual([1, 2, 3, 4, 5]);
		expect(pageNumbers(1, 9)).toEqual([1, 2, 3, 4, 5, null, 9]);
		expect(pageNumbers(4, 9)).toEqual([1, 2, 3, 4, 5, null, 9]);
		expect(pageNumbers(5, 9)).toEqual([1, null, 4, 5, 6, null, 9]);
		expect(pageNumbers(6, 9)).toEqual([1, null, 5, 6, 7, 8, 9]);
		expect(pageNumbers(9, 9)).toEqual([1, null, 5, 6, 7, 8, 9]);
	});

	it("renders the range, the pages, the current page and the size choice", () => {
		const markup = renderPager({ offset: 25, limit: 25, total: 204 }).value;
		expect(markup).toContain("26–50 of 204");
		expect(markup).toContain('<button type="button" data-page-offset="0" aria-label="Previous page">');
		expect(markup).toContain('<button type="button" data-page-offset="50" aria-label="Next page">');
		expect(markup).toContain('<button type="button" data-page-offset="25" aria-current="page">2</button>');
		expect(markup).toContain('<button type="button" data-page-offset="200">9</button>');
		expect(markup).toContain('<option value="25" selected>25</option>');
		expect(markup).toContain('<option value="100">100</option>');
		expect(DEFAULT_PAGE_SIZE).toBe(25);
		expect(PAGE_SIZES).toEqual([25, 50, 100]);
	});

	it("disables Previous on the first page and Next on the last, and still shows one page for a short table", () => {
		const first = renderPager({ offset: 0, limit: 25, total: 40 }).value;
		expect(first).toContain('aria-label="Previous page" disabled>');
		expect(first).toContain("1–25 of 40");
		const last = renderPager({ offset: 25, limit: 25, total: 40 }).value;
		expect(last).toContain('aria-label="Next page" disabled>');
		expect(last).toContain("26–40 of 40");
		const one = renderPager({ offset: 0, limit: 25, total: 6 }).value;
		expect(one).toContain("1–6 of 6");
		expect(one).toContain('aria-current="page">1</button>');
		expect(one).toContain('aria-label="Next page" disabled>');
	});

	it("renders nothing for an empty table", () => {
		expect(renderPager({ offset: 0, limit: 25, total: 0 }).value).toBe("");
	});
});
