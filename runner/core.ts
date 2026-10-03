// Loading, running, and comparing experiments; shared by the CLI (runner/run.ts) and the local UI (ui/server.ts).
//
// Key-free experiments are deterministic: their result is compared with snapshot.json, and a difference means pi's
// behavior changed. Experiments that call real models vary between runs: their result is written to last-run.json.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lineDiff } from "./diff.ts";

export const ROOT = join(import.meta.dirname, "..");
const EXPERIMENTS = join(ROOT, "experiments");

export interface Meta {
	title: string;
	feature: string;
	/** Environment variables the experiment needs. Empty: offline, compared with snapshot.json. */
	keys: string[];
	timeoutMs?: number;
}

export interface Experiment {
	name: string;
	dir: string;
	meta: Meta;
}

export type Status = "unchanged" | "changed" | "new" | "updated" | "recorded" | "failed" | "skipped";

export interface Outcome {
	name: string;
	status: Status;
	seconds: number;
	/** Diff for changed/updated snapshots, error and log tail for failures, missing keys for skips. */
	detail?: string;
	/** The parsed result, when the experiment produced one. */
	result?: unknown;
}

export interface RunOptions {
	/** Write the new result to snapshot.json when it differs. */
	update?: boolean;
	/** Environment for the experiment process. Default: process.env. */
	env?: NodeJS.ProcessEnv;
	/** Receives the experiment's stderr (its log) as it arrives. */
	onLog?: (chunk: string) => void;
	/** Aborting kills the experiment process. */
	signal?: AbortSignal;
}

export function loadExperiments(): Experiment[] {
	return readdirSync(EXPERIMENTS, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(EXPERIMENTS, entry.name, "run.ts")))
		.map((entry) => {
			const dir = join(EXPERIMENTS, entry.name);
			const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Meta;
			return { name: entry.name, dir, meta };
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function piVersions(): string {
	const names = ["pi-ai", "pi-durable", "pi-codemode", "pi-coding-agent"];
	return names
		.map((name) => {
			const file = join(ROOT, "node_modules", "@earendil-works", name, "package.json");
			return `${name}@${JSON.parse(readFileSync(file, "utf8")).version}`;
		})
		.join(", ");
}

function execute(
	experiment: Experiment,
	options: RunOptions,
): Promise<{ code: number | null; stdout: string; stderr: string; aborted: boolean }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [join(experiment.dir, "run.ts")], { cwd: ROOT, env: options.env ?? process.env });
		let stdout = "";
		let stderr = "";
		let aborted = false;
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk;
			options.onLog?.(chunk.toString());
		});
		const kill = () => {
			aborted = true;
			child.kill("SIGKILL");
		};
		options.signal?.addEventListener("abort", kill, { once: true });
		const timer = setTimeout(kill, experiment.meta.timeoutMs ?? 120_000);
		child.on("close", (code) => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", kill);
			resolve({ code, stdout, stderr, aborted });
		});
	});
}

export function missingKeys(experiment: Experiment, env: NodeJS.ProcessEnv = process.env): string[] {
	return experiment.meta.keys.filter((key) => !env[key]);
}

export function snapshotFile(experiment: Experiment): string {
	return join(experiment.dir, "snapshot.json");
}

export function lastRunFile(experiment: Experiment): string {
	return join(experiment.dir, "last-run.json");
}

const toJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export async function runExperiment(experiment: Experiment, options: RunOptions = {}): Promise<Outcome> {
	const name = experiment.name;
	const missing = missingKeys(experiment, options.env);
	if (missing.length > 0) return { name, status: "skipped", seconds: 0, detail: `missing ${missing.join(", ")}` };

	const started = performance.now();
	const { code, stdout, stderr, aborted } = await execute(experiment, options);
	const seconds = Math.round((performance.now() - started) / 100) / 10;
	let result: unknown;
	try {
		if (aborted) throw new Error("aborted or timed out");
		if (code !== 0) throw new Error(`exit code ${code}`);
		result = JSON.parse(stdout);
	} catch (error) {
		const tail = stderr.trim().split("\n").slice(-15).join("\n");
		return { name, status: "failed", seconds, detail: `${(error as Error).message}\n${tail}` };
	}
	const json = toJson(result);

	if (experiment.meta.keys.length > 0) {
		writeFileSync(lastRunFile(experiment), toJson({ ranAt: new Date().toISOString(), versions: piVersions(), result }));
		return { name, status: "recorded", seconds, result };
	}

	const file = snapshotFile(experiment);
	if (!existsSync(file)) {
		writeFileSync(file, json);
		return { name, status: "new", seconds, result };
	}
	const previous = readFileSync(file, "utf8");
	if (previous === json) return { name, status: "unchanged", seconds, result };
	if (options.update) writeFileSync(file, json);
	return { name, status: options.update ? "updated" : "changed", seconds, detail: lineDiff(previous, json), result };
}

/** Accept a result as the new snapshot of a key-free experiment. */
export function acceptSnapshot(experiment: Experiment, result: unknown): void {
	if (experiment.meta.keys.length > 0) throw new Error(`${experiment.name} has no snapshot: it needs API keys`);
	writeFileSync(snapshotFile(experiment), toJson(result));
}

export function report(outcomes: Outcome[]): string {
	const lines = [`# pi-lab run`, "", `Versions: ${piVersions()}`, "", "| Experiment | Status | Seconds |", "|---|---|---|"];
	for (const outcome of outcomes) lines.push(`| ${outcome.name} | ${outcome.status} | ${outcome.seconds} |`);
	for (const outcome of outcomes.filter((each) => each.detail && each.status !== "skipped")) {
		lines.push("", `## ${outcome.name}: ${outcome.status}`, "", "```diff", outcome.detail!.trimEnd(), "```");
	}
	return `${lines.join("\n")}\n`;
}
