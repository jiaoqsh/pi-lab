// Run experiments from the command line and compare their results with the stored ones.
//
//   npm run exp -- list                       list experiments and the keys they need
//   npm run exp -- codemode-sandbox           run one (or several) experiments
//   npm run exp -- --offline                  run every experiment that needs no API keys
//   npm run exp -- --all                      run every experiment whose keys are set
//   flags: --update (accept new results)  --report <file> (write a markdown report)
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Experiment, loadExperiments, type Outcome, ROOT, report, runExperiment } from "./core.ts";

try {
	process.loadEnvFile(join(ROOT, ".env"));
} catch {
	// No .env: only key-free experiments run.
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
else {
	selected = names.map((name) => {
		const found = experiments.find((each) => each.name === name);
		if (!found) throw new Error(`Unknown experiment ${name}. Run: npm run exp -- list`);
		return found;
	});
}

const verbose = Boolean(process.env.PI_LAB_VERBOSE);
const outcomes: Outcome[] = [];
for (const experiment of selected) {
	process.stderr.write(`${experiment.name} … `);
	const outcome = await runExperiment(experiment, {
		update,
		onLog: verbose ? (chunk) => process.stderr.write(chunk) : undefined,
	});
	process.stderr.write(`${outcome.status} (${outcome.seconds}s)\n`);
	if (outcome.detail && outcome.status !== "unchanged") process.stderr.write(`${outcome.detail.trimEnd()}\n`);
	outcomes.push(outcome);
}
if (reportFile) writeFileSync(reportFile, report(outcomes));
const bad = outcomes.some((each) => each.status === "failed" || each.status === "changed");
process.exit(bad ? 1 : 0);
