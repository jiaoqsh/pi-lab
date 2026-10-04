// A/B test of one sentence in the codemode tool description. pi 1.0 lists the discovery helpers without saying they
// are async; the variant adds `await` in front of the three async ones and changes nothing else. Both run the same
// task (find a hidden MCP tool, call it) many times; the outcome is how often a script serialized an unawaited promise.
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { emit, log, requireEnv, ROOT, scratchDir, truncate } from "../../lib/experiment.ts";
import { createAgentDir, messagesOf, PI_CLI, type PiRun, runPi, textOf, usageOf } from "../../lib/pi-cli.ts";

requireEnv("DEEPSEEK_API_KEY");

const RUNS_PER_CELL = Number(process.env.AB_RUNS ?? 10);
const CONCURRENCY = 8;
const MODELS = ["deepseek-flash", "deepseek-v4-pro"];
const PROMPT = "Using the shop backend, look up customer C16 and tell me their tier.";

const ORIGINAL =
	"`ALL_TOOLS`, `searchTools(query, { limit?, namespace? })`, `describeTool(name)`, `describeNamespace(name)`: find unlisted tools, such as MCP tools.";
const PATCHED =
	"`ALL_TOOLS`, `await searchTools(query, { limit?, namespace? })`, `await describeTool(name)`, `await describeNamespace(name)`: find unlisted tools, such as MCP tools.";

/** Copy the published package and swap the one sentence. Throws if pi no longer contains it (the A/B is then moot). */
function buildVariant(): string {
	const packageDir = join(dirname(PI_CLI), "..", "..");
	// Inside pi-lab, so the copy still resolves its dependencies from pi-lab's node_modules.
	const copy = join(scratchDir("pi-await-variant"), "node_modules", "@earendil-works", "pi-coding-agent");
	cpSync(packageDir, copy, { recursive: true });
	const chunks = join(copy, "dist", "bundle", "chunks");
	const matches = readdirSync(chunks).filter((file) => readFileSync(join(chunks, file), "utf8").includes(ORIGINAL));
	if (matches.length !== 1) throw new Error(`expected the description sentence in one chunk, found ${matches.length}`);
	const file = join(chunks, matches[0]);
	writeFileSync(file, readFileSync(file, "utf8").replace(ORIGINAL, PATCHED));
	return join(copy, "dist", "bundle", "cli.js");
}

/** What happened in one run. `{}` output is how an unawaited promise shows up in pi 1.0. */
function measure(run: PiRun) {
	const assistants = messagesOf(run, "assistant");
	const scripts = assistants.flatMap((message) =>
		typeof message.content === "string"
			? []
			: message.content.filter((block) => block.type === "toolCall" && block.name === "codemode").map((block) => String(block.arguments?.code ?? "")),
	);
	const results = messagesOf(run, "toolResult").filter((m) => m.toolName === "codemode").map(textOf);
	const promiseAsJson = results.filter((text) => /Output:\n(\{\}|\[\{\}(, ?\{\})*\])\s*$/.test(text)).length;
	const answer = assistants.length ? textOf(assistants.at(-1)!) : "";
	// The codemode declaration the model actually received, from the session's system messages.
	const codemode = run.session
		.flatMap((entry) => (entry.message?.role === "system" ? (entry.message.toolsAdded ?? []) : []))
		.find((tool) => tool.name === "codemode") as { description?: string } | undefined;
	return {
		descriptionHasAwait: Boolean(codemode?.description?.includes("`await searchTools(")),
		correct: /basic/i.test(answer),
		promiseAsJson,
		parameterRedefinition: results.filter((text) => text.includes("redefinition of parameter")).length,
		...usageOf(run),
		firstScript: truncate(scripts[0] ?? "", 140),
	};
}

async function pool<T>(tasks: (() => Promise<T>)[], size: number): Promise<T[]> {
	const results: T[] = new Array(tasks.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: size }, async () => {
			while (next < tasks.length) {
				const index = next++;
				results[index] = await tasks[index]();
			}
		}),
	);
	return results;
}

const variants = { "1.0.0 description": PI_CLI, "with await": buildVariant() };
const tasks = Object.entries(variants).flatMap(([variant, cli]) =>
	MODELS.flatMap((model) =>
		Array.from({ length: RUNS_PER_CELL }, (_, i) => async () => {
			const agentDir = createAgentDir(`ab-${i}`, { shopExposure: "codemode" });
			const run = await runPi(agentDir, scratchDir("cwd"), ["--model", `deepseek/${model}`], PROMPT, 300_000, cli);
			log(`${variant} ${model} #${i + 1}: exit ${run.exitCode}`);
			return { variant, model, ...measure(run) };
		}),
	),
);
const runs = await pool(tasks, CONCURRENCY);

const mean = (values: number[]) => Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
const cells: Record<string, unknown> = {};
for (const variant of Object.keys(variants)) {
	for (const model of MODELS) {
		const cell = runs.filter((run) => run.variant === variant && run.model === model);
		cells[`${variant} / ${model}`] = {
			runs: cell.length,
			descriptionHasAwait: cell.filter((run) => run.descriptionHasAwait).length,
			runsWithPromiseAsJson: cell.filter((run) => run.promiseAsJson > 0).length,
			runsWithParameterRedefinition: cell.filter((run) => run.parameterRedefinition > 0).length,
			correct: cell.filter((run) => run.correct).length,
			meanTurns: mean(cell.map((run) => run.turns)),
			meanCostUsd: Math.round(mean(cell.map((run) => run.costUsd * 1e5))) / 1e5,
		};
	}
}
await emit({ prompt: PROMPT, sentence: { original: ORIGINAL, patched: PATCHED }, cells, runs });
