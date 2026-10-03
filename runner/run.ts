// Run experiments and compare their results with the stored ones.
//
//   npm run exp -- list                       list experiments and the keys they need
//   npm run exp -- codemode-sandbox           run one (or several) experiments
//   npm run exp -- --offline                  run every experiment that needs no API keys
//   npm run exp -- --all                      run every experiment whose keys are set
//   flags: --update (accept new results)  --report <file> (write a markdown report)
//
// Key-free experiments are deterministic: their result is compared with snapshot.json, and a difference means pi's
// behavior changed. Experiments that call real models vary between runs: their result is written to last-run.json.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lineDiff } from "./diff.ts";

const ROOT = join(import.meta.dirname, "..");
const EXPERIMENTS = join(ROOT, "experiments");

interface Meta {
	title: string;
	feature: string;
	/** Environment variables the experiment needs. Empty: offline, compared with snapshot.json. */
	keys: string[];
	timeoutMs?: number;
}

interface Experiment {
	name: string;
	dir: string;
	meta: Meta;
}

type Status = "unchanged" | "changed" | "new" | "updated" | "recorded" | "failed" | "skipped";

interface Outcome {
	name: string;
	status: Status;
	seconds: number;
	detail?: string;
}

try {
	process.loadEnvFile(join(ROOT, ".env"));
} catch {
	// No .env: only key-free experiments run.
}

function loadExperiments(): Experiment[] {
	return readdirSync(EXPERIMENTS, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(EXPERIMENTS, entry.name, "run.ts")))
		.map((entry) => {
			const dir = join(EXPERIMENTS, entry.name);
			const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Meta;
			return { name: entry.name, dir, meta };
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

function piVersions(): string {
	const names = ["pi-ai", "pi-durable", "pi-codemode", "pi-coding-agent"];
	return names
		.map((name) => {
			const file = join(ROOT, "node_modules", "@earendil-works", name, "package.json");
			return `${name}@${JSON.parse(readFileSync(file, "utf8")).version}`;
		})
		.join(", ");
}

function execute(experiment: Experiment): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [join(experiment.dir, "run.ts")], { cwd: ROOT, env: process.env });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			if (process.env.PI_LAB_VERBOSE) process.stderr.write(chunk);
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), experiment.meta.timeoutMs ?? 120_000);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

async function runOne(experiment: Experiment, update: boolean): Promise<Outcome> {
	const missing = experiment.meta.keys.filter((key) => !process.env[key]);
	if (missing.length > 0) return { name: experiment.name, status: "skipped", seconds: 0, detail: `missing ${missing.join(", ")}` };

	const started = performance.now();
	const { code, stdout, stderr } = await execute(experiment);
	const seconds = Math.round((performance.now() - started) / 100) / 10;
	let result: unknown;
	try {
		if (code !== 0) throw new Error(`exit code ${code}`);
		result = JSON.parse(stdout);
	} catch (error) {
		const tail = stderr.trim().split("\n").slice(-15).join("\n");
		return { name: experiment.name, status: "failed", seconds, detail: `${(error as Error).message}\n${tail}` };
	}
	const json = `${JSON.stringify(result, null, 2)}\n`;

	if (experiment.meta.keys.length > 0) {
		const record = { ranAt: new Date().toISOString(), versions: piVersions(), result };
		writeFileSync(join(experiment.dir, "last-run.json"), `${JSON.stringify(record, null, 2)}\n`);
		return { name: experiment.name, status: "recorded", seconds };
	}

	const snapshotFile = join(experiment.dir, "snapshot.json");
	if (!existsSync(snapshotFile)) {
		writeFileSync(snapshotFile, json);
		return { name: experiment.name, status: "new", seconds };
	}
	const previous = readFileSync(snapshotFile, "utf8");
	if (previous === json) return { name: experiment.name, status: "unchanged", seconds };
	if (update) writeFileSync(snapshotFile, json);
	return { name: experiment.name, status: update ? "updated" : "changed", seconds, detail: lineDiff(previous, json) };
}

function report(outcomes: Outcome[]): string {
	const lines = [`# pi-lab run`, "", `Versions: ${piVersions()}`, "", "| Experiment | Status | Seconds |", "|---|---|---|"];
	for (const outcome of outcomes) lines.push(`| ${outcome.name} | ${outcome.status} | ${outcome.seconds} |`);
	for (const outcome of outcomes.filter((each) => each.detail && each.status !== "skipped")) {
		lines.push("", `## ${outcome.name}: ${outcome.status}`, "", "```diff", outcome.detail!.trimEnd(), "```");
	}
	return `${lines.join("\n")}\n`;
}

const args = process.argv.slice(2);
const update = args.includes("--update");
const reportIndex = args.indexOf("--report");
const reportFile = reportIndex === -1 ? undefined : args[reportIndex + 1];
const names = args.filter((arg, index) => !arg.startsWith("--") && (reportIndex === -1 || index !== reportIndex + 1));
const experiments = loadExperiments();

if (names[0] === "list") {
	for (const { name, meta } of experiments) {
		console.log(`${name.padEnd(26)} ${meta.feature.padEnd(16)} ${meta.keys.length ? meta.keys.join(",") : "offline"}  ${meta.title}`);
	}
	process.exit(0);
}

let selected: Experiment[];
if (args.includes("--offline")) selected = experiments.filter((each) => each.meta.keys.length === 0);
else if (args.includes("--all")) selected = experiments;
else selected = names.map((name) => {
	const found = experiments.find((each) => each.name === name);
	if (!found) throw new Error(`Unknown experiment ${name}. Run: npm run exp -- list`);
	return found;
});

const outcomes: Outcome[] = [];
for (const experiment of selected) {
	process.stderr.write(`${experiment.name} … `);
	const outcome = await runOne(experiment, update);
	process.stderr.write(`${outcome.status} (${outcome.seconds}s)\n`);
	if (outcome.detail && outcome.status !== "unchanged") process.stderr.write(`${outcome.detail.trimEnd()}\n`);
	outcomes.push(outcome);
}
if (reportFile) writeFileSync(reportFile, report(outcomes));
const bad = outcomes.some((each) => each.status === "failed" || each.status === "changed");
process.exit(bad ? 1 : 0);
