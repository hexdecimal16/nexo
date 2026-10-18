import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds the single publishable package into dist/. Dev keeps running TypeScript source directly; this only
 * produces the release artifact. Steps: tsc -> rewrite @nexo/* imports to relative paths -> point the regex worker
 * URL at .js -> copy migrations, bundled skills and web public -> generate package.json with merged dependencies.
 * The package name comes from NEXO_RELEASE_NAME (default "nexo").
 */

interface PackageJson {
	name: string;
	version: string;
	bin?: Record<string, string>;
	exports?: Record<string, string>;
	engines?: Record<string, string>;
	dependencies?: Record<string, string>;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const packagesDir = join(root, "packages");
const releaseName = process.env.NEXO_RELEASE_NAME ?? "nexo";

const readJson = (file: string): PackageJson => JSON.parse(readFileSync(file, "utf8")) as PackageJson;
const toJs = (path: string): string => path.replace(/\.ts$/, ".js");
const toPosix = (path: string): string => path.split(sep).join("/");

const dirs = readdirSync(packagesDir, { withFileTypes: true })
	.filter((d) => d.isDirectory() && existsSync(join(packagesDir, d.name, "package.json")))
	.map((d) => d.name)
	.sort();
const manifests = new Map<string, PackageJson>(dirs.map((d) => [d, readJson(join(packagesDir, d, "package.json"))]));

// Maps "@nexo/core" to the absolute path of its compiled entry file in dist.
const entryByName = new Map<string, string>();
for (const [dir, manifest] of manifests) {
	const entry = manifest.exports?.["."];
	if (entry) entryByName.set(manifest.name, join(dist, dir, toJs(entry)));
}

// 1. Compile. noEmitOnError makes type errors fail the build.
rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.release.json")], { cwd: root, stdio: "inherit" });

// 2. Rewrite workspace specifiers to relative paths, and the worker URL to .js.
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(@nexo\/[a-z0-9-]+)\2/g;
const TS_URL = /new URL\((["'])(\.[^"']*)\.ts\1,\s*import\.meta\.url\)/g;
let workerUrls = 0;

const jsFiles = readdirSync(dist, { recursive: true })
	.map(String)
	.filter((f) => f.endsWith(".js"))
	.map((f) => join(dist, f));

for (const file of jsFiles) {
	const source = readFileSync(file, "utf8");
	const out = source
		.replace(SPECIFIER, (_match, lead: string, quote: string, spec: string) => {
			const entry = entryByName.get(spec);
			if (!entry) throw new Error(`${file}: unknown workspace package ${spec}`);
			let rel = toPosix(relative(dirname(file), entry));
			if (!rel.startsWith(".")) rel = `./${rel}`;
			return `${lead}${quote}${rel}${quote}`;
		})
		.replace(TS_URL, (_match, quote: string, base: string) => {
			workerUrls++;
			return `new URL(${quote}${base}.js${quote}, import.meta.url)`;
		});
	if (out !== source) writeFileSync(file, out);
	if (/["']@nexo\//.test(out)) throw new Error(`${file}: a quoted @nexo/ specifier is still present after rewriting`);
}
if (workerUrls === 0) throw new Error("Expected to rewrite at least one new URL(\"*.ts\", import.meta.url) (the regex worker) but found none");

// 3. Copy assets the compiler does not emit. tsc may have emitted type-only imports from web/public, so clear that first.
rmSync(join(dist, "web", "public"), { recursive: true, force: true });
cpSync(join(packagesDir, "store/src/migrations"), join(dist, "store/src/migrations"), { recursive: true });
cpSync(join(packagesDir, "skills/bundled"), join(dist, "skills/bundled"), { recursive: true });
cpSync(join(packagesDir, "web/public"), join(dist, "web/public"), {
	recursive: true,
	filter: (src) => !src.endsWith(`${sep}tsconfig.json`),
});

// 4. Generate package.json: third-party dependencies merged across packages, bin and exports from the cli package.
const deps: Record<string, string> = {};
for (const manifest of manifests.values()) {
	for (const [dep, version] of Object.entries(manifest.dependencies ?? {})) {
		if (dep.startsWith("@nexo/")) continue;
		const existing = deps[dep];
		if (existing && existing !== version) throw new Error(`${dep} is pinned to both ${existing} and ${version}`);
		deps[dep] = version;
	}
}
const sortedDeps = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));

const cli = manifests.get("cli");
const cliBin = cli?.bin?.nexo;
const cliMain = cli?.exports?.["."];
if (!cli || !cliBin || !cliMain) throw new Error("packages/cli must define bin.nexo and exports['.']");
const bin = `./cli/${toPosix(toJs(cliBin)).replace(/^\.\//, "")}`;
const main = `./cli/${toPosix(toJs(cliMain)).replace(/^\.\//, "")}`;

const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
const release = {
	name: releaseName,
	version: cli.version,
	description: "nexo agent engine",
	type: "module",
	bin: { nexo: bin },
	main,
	exports: { ".": main },
	files: dirs,
	engines: rootManifest.engines,
	dependencies: sortedDeps,
};
writeFileSync(join(dist, "package.json"), `${JSON.stringify(release, null, 2)}\n`);
chmodSync(join(dist, bin), 0o755);

console.log(`Built ${releaseName}@${cli.version} in dist/ (${jsFiles.length} js files, ${Object.keys(sortedDeps).length} dependencies, ${workerUrls} worker URL rewritten)`);
