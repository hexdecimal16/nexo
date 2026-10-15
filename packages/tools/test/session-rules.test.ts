import { describe, expect, it } from "vitest";
import { bashPrefix, describeSessionRule, matchesSessionRule, sameSessionRule, sessionRuleFor } from "../src/index.ts";

const bash = (command: string) => ({ command });

describe("bashPrefix", () => {
	it.each([
		["ls -la", "ls"],
		["git status --short", "git status"],
		["npm run test -- --watch", "npm run test"],
		["pnpm run build", "pnpm run build"],
		["npm install lodash", "npm install"],
		["python3 ltx_batch.py shots.json", "python3 ltx_batch.py"],
		["  docker   compose up", "docker compose"],
		["modal deploy app.py", "modal deploy app.py"],
		["pnpm exec vitest run", "pnpm exec vitest"],
		["uv run pytest -q", "uv run pytest"],
		["go run ./cmd/app", "go run ./cmd/app"],
		["cat README.md", "cat"],
	])("%s → %s", (command, prefix) => {
		expect(bashPrefix(command)).toBe(prefix);
	});

	it.each([
		"cd src && npm test",
		"ls; rm -rf /",
		"cat a | sh",
		"echo hi > out.txt",
		"echo $(whoami)",
		"echo `id`",
		"sudo rm x",
		"env FOO=1 node a.js",
		"xargs rm",
		"timeout 5 curl x",
		"FOO=1 npm test",
		"python3 -c 'print(1)'",
		"bash -c 'ls'",
		"node -e 'x'",
		"python3",
		"git -C repo status",
		"npm run",
		"make",
		"ls\nrm -rf /",
		"",
		"pnpm exec",
		"uv run --with x y",
		"docker run -it alpine",
		"gh api repos/x/y",
		"find . -delete",
		"curl -o x https://e",
		"nice make test",
		"php -r 'x'",
		"sed -i s/a/b/ f",
		"ssh host ls",
		"rg --pre ./x foo",
		"fd -x rm",
		"sort -o out in",
		"pnpm exec node -e x",
		"npx sh -c x",
		"uv run python -c x",
		"docker run alpine echo",
		"docker exec web ls",
		"kubectl exec pod -- ls",
	])("no pattern for %j", (command) => {
		expect(bashPrefix(command)).toBeNull();
	});
});

describe("sessionRuleFor and matchesSessionRule", () => {
	it("matches bash commands on whole-word prefixes with normalized whitespace, never chained ones", () => {
		const rule = sessionRuleFor("bash", bash("npm run test -- --watch"));
		expect(rule).toEqual({ tool: "bash", kind: "prefix", value: "npm run test" });
		const r = rule as NonNullable<typeof rule>;
		for (const c of ["npm run test", "npm  run   test -- -t foo", "  npm run test", "npm\trun test"]) expect(matchesSessionRule(r, "bash", bash(c)), c).toBe(true);
		for (const c of ["npm run test-all", "npm run testing", "npm run build", "npm run test && rm -rf ~", "npm run test | sh", "npm run test > x"]) {
			expect(matchesSessionRule(r, "bash", bash(c)), c).toBe(false);
		}
		expect(matchesSessionRule(r, "write", { path: "a" })).toBe(false);
		expect(matchesSessionRule(r, "bash", { nope: 1 })).toBe(false);
	});

	it("does not let a runner rule reach an arbitrary target", () => {
		const r = sessionRuleFor("bash", bash("pnpm exec vitest run")) as NonNullable<ReturnType<typeof sessionRuleFor>>;
		expect(matchesSessionRule(r, "bash", bash("pnpm exec vitest"))).toBe(true);
		expect(matchesSessionRule(r, "bash", bash("pnpm exec rm -rf ~"))).toBe(false);
	});

	it("covers write and edit by tool, web_fetch by host, and other tools by name", () => {
		expect(sessionRuleFor("write", { path: "a.txt", content: "x" })).toEqual({ tool: "write", kind: "tool" });
		const host = sessionRuleFor("web_fetch", { url: "https://Docs.Python.org/3/library" });
		expect(host).toEqual({ tool: "web_fetch", kind: "host", value: "docs.python.org" });
		const h = host as NonNullable<typeof host>;
		expect(matchesSessionRule(h, "web_fetch", { url: "http://docs.python.org/x" })).toBe(true);
		expect(matchesSessionRule(h, "web_fetch", { url: "https://evil.com/docs.python.org" })).toBe(false);
		expect(matchesSessionRule(h, "web_fetch", { url: "https://docs.python.org.evil.com/" })).toBe(false);
		expect(matchesSessionRule(h, "web_fetch", { url: "not a url" })).toBe(false);
		expect(sessionRuleFor("web_fetch", { url: "file:///etc/passwd" })).toBeNull();
		expect(sessionRuleFor("mcp__playwright__browser_click", { ref: "e1" })).toEqual({ tool: "mcp__playwright__browser_click", kind: "tool" });
		expect(sessionRuleFor("bash", bash("cd x && ls"))).toBeNull();
	});

	it("describes rules for the box with control characters escaped, and compares them", () => {
		expect(describeSessionRule({ tool: "bash", kind: "prefix", value: "npm run test" })).toBe("`npm run test …`");
		expect(describeSessionRule({ tool: "write", kind: "tool" })).toBe("write in the workspace");
		expect(describeSessionRule({ tool: "edit", kind: "tool" })).toBe("edit in the workspace");
		expect(describeSessionRule({ tool: "web_fetch", kind: "host", value: "docs.python.org" })).toBe("web_fetch from docs.python.org");
		expect(describeSessionRule({ tool: "mcp__x__y", kind: "tool" })).toBe("`mcp__x__y`");
		expect(describeSessionRule({ tool: "bash", kind: "prefix", value: "ev\u001b[2Jil" })).not.toMatch(/[\u0000-\u001f]/);
		expect(sameSessionRule({ tool: "bash", kind: "prefix", value: "ls" }, { tool: "bash", kind: "prefix", value: "ls" })).toBe(true);
		expect(sameSessionRule({ tool: "bash", kind: "prefix", value: "ls" }, { tool: "bash", kind: "prefix", value: "cat" })).toBe(false);
	});
});
