import { describe, expect, it } from "vitest";
import { EDITABLE_SETTINGS, SETTING_GROUPS } from "../src/settings/config-edit.ts";

describe("setting groups", () => {
	it("puts every setting in a known group", () => {
		const ids = new Set(SETTING_GROUPS.map((g) => g.id));
		for (const def of EDITABLE_SETTINGS) expect(ids.has(def.group), def.key).toBe(true);
	});

	it("lists settings group by group in SETTING_GROUPS order", () => {
		const order = SETTING_GROUPS.map((g) => g.id);
		const positions = EDITABLE_SETTINGS.map((def) => order.indexOf(def.group));
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});

	it("has no empty group and no duplicate key", () => {
		for (const g of SETTING_GROUPS) expect(EDITABLE_SETTINGS.some((d) => d.group === g.id), g.id).toBe(true);
		const keys = EDITABLE_SETTINGS.map((d) => d.key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("groups related keys together", () => {
		const group = (key: string) => EDITABLE_SETTINGS.find((d) => d.key === key)?.group;
		expect(group("models.s1")).toBe("models");
		expect(group("models.judge")).toBe("scoring");
		expect(group("budgets.optimDefaultUsd")).toBe("optimize");
		expect(group("loop.repeatLimit")).toBe("runs");
		expect(group("learning.enabled")).toBe("memory");
	});
});
