import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Sets one version on every workspace package and on the exact @nexo/* dependency pins between them, then refreshes
 * package-lock.json. Usage: npm run bump -- patch|minor|major|<x.y.z>. Text is edited in place so the files keep their
 * formatting. Committing and tagging stay manual.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const files = readdirSync(packagesDir, { withFileTypes: true })
	.filter((d) => d.isDirectory())
	.map((d) => join(packagesDir, d.name, "package.json"))
	.filter((f) => existsSync(f));

const versions = new Set(files.map((f) => (JSON.parse(readFileSync(f, "utf8")) as { version: string }).version));
if (versions.size !== 1) throw new Error(`Workspace packages are on different versions: ${[...versions].join(", ")}`);
const current = [...versions][0] as string;
const parsed = SEMVER.exec(current);
if (!parsed) throw new Error(`Current version ${current} is not x.y.z`);
const [major, minor, patch] = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])];

const arg = process.argv[2];
let next: string;
if (arg === "patch") next = `${major}.${minor}.${patch + 1}`;
else if (arg === "minor") next = `${major}.${minor + 1}.0`;
else if (arg === "major") next = `${major + 1}.0.0`;
else if (arg && SEMVER.test(arg)) next = arg;
else throw new Error("Usage: npm run bump -- patch|minor|major|<x.y.z>");

for (const file of files) {
	const text = readFileSync(file, "utf8");
	const out = text
		.replace(/("version":\s*")[^"]+(")/, `$1${next}$2`)
		.replace(/("@nexo\/[a-z0-9-]+":\s*")[^"]+(")/g, `$1${next}$2`);
	if (out !== text) writeFileSync(file, out);
}

execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });
console.log(`Bumped ${files.length} packages from ${current} to ${next}`);
