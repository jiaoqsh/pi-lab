// A "deploy" tool runs three steps; each step appends a line to side-effects.log (the outside world). The first
// process exits right after step 2. A second process reopens the same JSONL storage and lets the Harness recover.
//
// Parent mode (no arguments) runs every scenario as two child processes and emits the comparison.
// Child mode: run.ts <dir> <safe|unsafe> <crash|resume> <flushWaitMs>
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ToolResultMessage, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, ToolResultEntry } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { emit, log, scratchDir } from "../../lib/experiment.ts";

type Mode = "safe" | "unsafe";
type Phase = "crash" | "resume";

async function child(directory: string, mode: Mode, phase: Phase, flushWaitMs: number): Promise<void> {
	const context = BACKGROUND_CONTEXT;
	const sideEffects = join(directory, "side-effects.log");
	const deploy = defineTool({
		name: "deploy",
		description: "Deploy the service in three steps",
		parameters: Type.Object({ service: Type.String() }),
		replay: mode === "safe" ? "safe" : undefined,
		execute: async (args, api, callContext) => {
			for (const step of [1, 2, 3]) {
				// memo: first write wins and survives restarts, so a replay can skip finished steps.
				if (mode === "safe" && (await api.memo<boolean>(`step-${step}`, callContext))) {
					api.output(`step ${step}: skipped (memo)\n`);
					continue;
				}
				appendFileSync(sideEffects, `${phase} process: ${args.service} step ${step}\n`);
				if (mode === "safe") await api.memo(`step-${step}`, true, callContext);
				api.output(`step ${step}: done\n`);
				// Output commits are asynchronous and spaced at least 100 ms apart.
				if (flushWaitMs > 0) await new Promise((resolve) => setTimeout(resolve, flushWaitMs));
				if (phase === "crash" && step === 2) process.exit(1);
			}
			return {};
		},
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "ops", tools: [deploy] }));

	// The crash run needs the tool call. The resume run only needs the final answer: the stored tool call is
	// recovered from storage, not requested from the model again.
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(
		phase === "crash"
			? [fauxAssistantMessage([fauxToolCall("deploy", { service: "api" }, { id: "d1" })], { stopReason: "toolUse" })]
			: [fauxAssistantMessage([fauxText("Done.")])],
	);

	const harness = await Harness.open(await openNodeJsonlStorage(directory, context), { models, registry }, context);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	// The same requestId in both processes: the resume run finds the submission the crash run made.
	const submission = await root.submit({ type: "input", content: "Deploy api", requestId: "deploy-1" }, context);
	const settled = await submission.wait(context);
	const entries = await root.entries({}, 50, undefined, context);
	const toolResult = [...entries.items].reverse().find((entry) => ToolResultEntry.is(entry));
	const message = toolResult?.model?.[0] as ToolResultMessage | undefined;
	await harness.close(context);
	process.stdout.write(
		JSON.stringify({
			submissionStatus: settled.status,
			transcript: [...entries.items].reverse().map((entry) => entry.kind),
			toolResult: message && {
				isError: message.isError,
				text: message.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
			},
		}),
	);
}

function scenario(mode: Mode, flushWaitMs: number) {
	const directory = scratchDir(`durable-${mode}`);
	const run = (phase: Phase) =>
		spawnSync(process.execPath, [import.meta.filename, directory, mode, phase, String(flushWaitMs)], {
			encoding: "utf8",
		});
	const crash = run("crash");
	const resume = run("resume");
	if (resume.status !== 0) throw new Error(`resume failed: ${resume.stderr}`);
	const sideEffects = join(directory, "side-effects.log");
	return {
		crashExitCode: crash.status,
		afterRestart: JSON.parse(resume.stdout),
		sideEffects: existsSync(sideEffects) ? readFileSync(sideEffects, "utf8").trim().split("\n") : [],
	};
}

if (process.argv.length > 2) {
	const [directory, mode, phase, flushWaitMs] = process.argv.slice(2);
	await child(directory, mode as Mode, phase as Phase, Number(flushWaitMs));
} else {
	const scenarios: Record<string, unknown> = {};
	for (const [name, mode, flushWaitMs] of [
		["unsafe (default replay)", "unsafe", 0],
		["unsafe, output given 250 ms to commit before the crash", "unsafe", 250],
		["safe replay + memo per step", "safe", 0],
	] as const) {
		log(name);
		scenarios[name] = scenario(mode, flushWaitMs);
	}
	await emit(scenarios);
}
