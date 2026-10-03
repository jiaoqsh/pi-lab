// Run pi with the router/auto virtual model on a complex coding task and on a simple question, then read the
// session files: the selection (model_change), each dispatched physical model, and the stored router state.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { emit, log, requireEnv, ROOT, scratchDir } from "../../lib/experiment.ts";
import { createAgentDir, type PiRun, runPi, textOf } from "../../lib/pi-cli.ts";

requireEnv("DEEPSEEK_API_KEY");
requireEnv("TYPESAFE_API_KEY");

const COMPLEX =
	"Design and implement an LRU cache with per-entry TTL expiry and a size-based eviction policy in lru.js (ES module). " +
	"Think carefully about edge cases: updating an existing key, expired entries counting toward size, and clock injection " +
	"for tests. Then write test.js using node:assert covering these cases and run it with node test.js until it passes.";
const SIMPLE = "In two sentences: what does `node --test` do?";

function timeline(run: PiRun) {
	return run.session.flatMap((entry) => {
		if (entry.type === "model_change") return [`selected ${entry.provider}/${entry.modelId}`];
		if (entry.type === "custom" && entry.customType === "pi.virtual-model-state") {
			return [`router state ${JSON.stringify((entry.data as { state: unknown }).state)}`];
		}
		const message = entry.message;
		if (entry.type !== "message" || message?.role !== "assistant" || typeof message.content === "string") return [];
		const tools = message.content.filter((block) => block.type === "toolCall").map((block) => block.name);
		const usage = message.usage!;
		return [
			`dispatched ${message.provider}/${message.model} thinking=${message.thinkingLevel} tools=[${tools.join(",")}] input=${usage.input} cacheRead=${usage.cacheRead}`,
		];
	});
}

const agentDir = createAgentDir("router", {
	extensions: [join(ROOT, "fixtures", "deepseek-router.ts")],
	settings: { defaultThinkingLevel: "low" },
});
const complexDir = scratchDir("router-complex");
const simpleDir = scratchDir("router-simple");
const [complex, simple] = await Promise.all([
	runPi(agentDir, complexDir, ["--model", "router/auto"], COMPLEX, 840_000),
	runPi(agentDir, simpleDir, ["--model", "router/auto"], SIMPLE),
]);
log(`complex exit ${complex.exitCode}, simple exit ${simple.exitCode}`);

const tests = spawnSync(process.execPath, ["test.js"], { cwd: complexDir, encoding: "utf8" });
const lastText = (run: PiRun) => {
	const assistants = run.session.filter((entry) => entry.message?.role === "assistant");
	return assistants.length ? textOf(assistants.at(-1)!.message!).slice(0, 300) : "";
};

await emit({
	complexTask: {
		timeline: timeline(complex),
		filesWritten: readdirSync(complexDir).sort(),
		testsPass: tests.status === 0,
	},
	simpleQuestion: { timeline: timeline(simple), answer: lastText(simple) },
});
