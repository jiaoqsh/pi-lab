// A/B test of one sentence in the codemode tool description. pi 1.0 lists the discovery helpers without saying they
// are async; the variant adds `await` in front of the three async ones and changes nothing else. Both run the same
// task (find a hidden MCP tool, call it) many times; the outcome is how often a script serialized an unawaited promise.
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { emit, log, requireEnv, ROOT, scratchDir, truncate } from "../../lib/experiment.ts";
import { createAgentDir, messagesOf, PI_CLI, type PiRun, runPi, textOf, usageOf } from "../../lib/pi-cli.ts";

const RUNS_PER_CELL = Number(process.env.AB_RUNS ?? 10);
const CONCURRENCY = 8;
/**
 * `provider/id` pairs, default the two DeepSeek models. `openai-relay/<id>` runs through the OpenAI-compatible endpoint
 * in OPENAI_BASE_URL with the Responses API, which pi uses for OpenAI models: AB_MODELS=openai-relay/gpt-5.6-sol.
 */
const MODELS = (process.env.AB_MODELS ?? "deepseek/deepseek-flash,deepseek/deepseek-v4-pro").split(",").map((m) => m.trim());
if (MODELS.some((model) => model.startsWith("deepseek/"))) requireEnv("DEEPSEEK_API_KEY");
const RELAY = "openai-relay";
const relayIds = MODELS.filter((model) => model.startsWith(`${RELAY}/`)).map((model) => model.slice(RELAY.length + 1));
if (relayIds.length) requireEnv("OPENAI_API_KEY");
// The key stays an environment reference: pi interpolates `$OPENAI_API_KEY` at request time.
const customModels = relayIds.length
	? {
			providers: {
				[RELAY]: {
					baseUrl: requireEnv("OPENAI_BASE_URL"),
					api: "openai-responses",
					apiKey: "$OPENAI_API_KEY",
					models: relayIds.map((id) => ({ id, reasoning: true })),
				},
			},
		}
	: undefined;
const PROMPT = "Using the shop backend, look up customer C16 and tell me their tier.";

const ORIGINAL =
	"`ALL_TOOLS`, `searchTools(query, { limit?, namespace? })`, `describeTool(name)`, `describeNamespace(name)`: find unlisted tools, such as MCP tools.";
const PATCHED =
	"`ALL_TOOLS`, `await searchTools(query, { limit?, namespace? })`, `await describeTool(name)`, `await describeNamespace(name)`: find unlisted tools, such as MCP tools.";

/** Chunk files of a pi-coding-agent bundle that contain `sentence`. */
function chunksWith(packageDir: string, sentence: string): string[] {
	const chunks = join(packageDir, "dist", "bundle", "chunks");
	return readdirSync(chunks)
		.map((file) => join(chunks, file))
		.filter((file) => readFileSync(file, "utf8").includes(sentence));
}

/** Copy the published package and swap the one sentence. */
function buildVariant(packageDir: string): string {
	// Inside pi-lab, so the copy still resolves its dependencies from pi-lab's node_modules.
	const copy = join(scratchDir("pi-await-variant"), "node_modules", "@earendil-works", "pi-coding-agent");
	cpSync(packageDir, copy, { recursive: true });
	const [file] = chunksWith(copy, ORIGINAL);
	writeFileSync(file, readFileSync(file, "utf8").replace(ORIGINAL, PATCHED));
	return join(copy, "dist", "bundle", "cli.js");
}

/**
 * The A/B while the published description lacks `await`. pi fixed it upstream (#10555, commit 269121616, the same
 * sentence as PATCHED): once a release ships it, only the published package runs, which verifies the fix.
 */
function chooseVariants(): Record<string, string> {
	const packageDir = join(dirname(PI_CLI), "..", "..");
	const original = chunksWith(packageDir, ORIGINAL).length;
	const patched = chunksWith(packageDir, PATCHED).length;
	if (original === 1) return { "published description": PI_CLI, "with await": buildVariant(packageDir) };
	if (patched === 1) {
		log("The published description already has `await` (#10555 shipped): running it alone.");
		return { "published description (has await, #10555)": PI_CLI };
	}
	throw new Error(`expected the description sentence in one chunk: original in ${original}, patched in ${patched}`);
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

const variants = chooseVariants();
const tasks = Object.entries(variants).flatMap(([variant, cli]) =>
	MODELS.flatMap((model) =>
		Array.from({ length: RUNS_PER_CELL }, (_, i) => async () => {
			const agentDir = createAgentDir(`ab-${i}`, { shopExposure: "codemode", models: customModels });
			const run = await runPi(agentDir, scratchDir("cwd"), ["--model", model], PROMPT, 300_000, cli);
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
			meanPromptTokens: Math.round(mean(cell.map((run) => run.inputTokens + run.cacheReadTokens))),
			meanCostUsd: Math.round(mean(cell.map((run) => run.costUsd * 1e5))) / 1e5,
		};
	}
}
await emit({ prompt: PROMPT, sentence: { original: ORIGINAL, patched: PATCHED }, cells, runs });
