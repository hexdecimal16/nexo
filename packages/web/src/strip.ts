import { stripTypeScriptTypes } from "node:module";

const STRIP_WARNING = "stripTypeScriptTypes is an experimental feature";

/**
 * Removes TypeScript types from a browser module (erasable syntax only; anything else throws
 * ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). Node emits a one-time ExperimentalWarning on the first call; this function
 * drops exactly that warning and passes every other warning through.
 */
export function stripBrowserTypeScript(source: string, sourceUrl: string): string {
	const emitWarning = process.emitWarning;
	process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
		const message = typeof warning === "string" ? warning : warning.message;
		if (message.startsWith(STRIP_WARNING)) return;
		(emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
	}) as typeof process.emitWarning;
	try {
		return stripTypeScriptTypes(source, { mode: "strip", sourceUrl });
	} finally {
		process.emitWarning = emitWarning;
	}
}
