// Helpers shared by experiments. An experiment is a script that prints exactly one JSON value to stdout (its result)
// and logs everything else to stderr, so the runner can compare results across pi releases.
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dirname, "..");

/** Progress for humans; stdout is reserved for the result. */
export function log(...args: unknown[]): void {
	console.error(...args);
}

/** Print the result and end the process, even if handles (workers, servers) are still open. */
export async function emit(result: unknown): Promise<never> {
	await new Promise<void>((resolve) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, () => resolve()));
	process.exit(0);
}

/** A fresh scratch directory under .tmp/ (ignored by git). */
export function scratchDir(name: string): string {
	const base = join(ROOT, ".tmp");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, `${name}-`));
}

/** Throw if an environment variable is missing; the runner skips experiments whose keys are unset. */
export function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

export function truncate(text: string, max = 160): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
