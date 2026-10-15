import { describe, expect, it } from "vitest";
import { isReadOnlyCommand } from "../src/index.ts";

describe("isReadOnlyCommand", () => {
	it("accepts the read-only commands a PR review runs", () => {
		for (const command of [
			"git status || pwd",
			"gh pr view 3955 --repo acme/widgets",
			"gh pr view 3955 --repo acme/widgets --json body,title,files,url,author,headRefName,baseRefName",
			"gh pr diff 3955 --repo acme/widgets",
			'find /Users/example -maxdepth 3 -name "widgets" 2>/dev/null',
			"cd /repo && git status",
			"cd /repo && git show pr-3955:src/a.yaml | sed -n '3440,3520p'",
			"cd /repo && git log -p -n 5 src/a.yaml",
			'cd /repo && git grep -n "bank_tampering"',
			"cd /repo && sed -n '19945,20025p' src/a.yaml",
			"grep -rn 'foo|bar' src | head -20",
			"ls -la; wc -l *.ts",
			"git -C /repo --no-pager diff HEAD~1 -- src",
			"git branch -a",
			"git branch --list 'feat/*'",
			"cat a.txt 2>&1 | sort | uniq -c",
			"sed -n '/^start/,/^end/p' file",
			"sed 's/a/b/g' file",
			'grep "end$" file',
			"which poetry || which uv",
		]) {
			expect(isReadOnlyCommand(command), command).toBe(true);
		}
	});

	it("rejects writes, network side effects, code execution and unknown programs", () => {
		for (const command of [
			"git fetch origin pull/3955/head:pr-3955",
			"git push",
			"git branch new-branch",
			"git branch -D old",
			"git tag v1",
			"git -c core.pager=sh log",
			"git diff --output=/tmp/x",
			"git grep -O foo",
			"gh api repos/x/y",
			"gh auth token",
			"gh pr checkout 1",
			"gh pr merge 1",
			"sed -i 's/a/b/' file",
			"sed 's/a/b/w out' file",
			"sed '1e rm -rf /' file",
			"sed -f script file",
			"find . -name x -delete",
			"find . -exec rm {} ;",
			"sort -o out in",
			"sort -uo out in",
			"uniq in out",
			"tree -o out",
			"rg --pre=sh foo",
			"echo hi > file",
			"echo hi >> file",
			"cat < file",
			"cat $(which ls)",
			"cat `which ls`",
			"echo $HOME",
			'echo "${HOME}"',
			"(ls)",
			"ls &",
			"ls\nrm -rf /",
			"FOO=1 git log",
			"./cat file",
			"/bin/rm -rf x",
			"rm -rf x",
			"curl https://example.com",
			"python3 -m pytest",
			"uv run pytest",
			"awk '{print}' file",
			"xargs rm",
			"env",
			"ls; rm x",
			"'unterminated",
			"",
		]) {
			expect(isReadOnlyCommand(command), command).toBe(false);
		}
	});

	it("leaves reads of credential files to the approver", () => {
		for (const command of ["cat ~/.ssh/id_rsa", "cat .env", "cat .env.local", "cat ~/.aws/credentials", "cat ~/.nexo/config.json", "grep -r token .", "cat server.pem"]) {
			expect(isReadOnlyCommand(command), command).toBe(false);
		}
	});
});
