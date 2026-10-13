// A codemode script calls a "step" tool three times; each step appends a line to side-effects.log (the outside
// world). The first process exits inside step 2, after its side effect. A second process reopens the same SQLite
// storage; the codemode call is replay-safe, so the Harness runs it again: the script is replayed from its journal and
// continues. The script also reads its clock and randomness, which must come back the same in the replay.
//
// Parent mode (no arguments) runs every scenario as two child processes and emits the comparison.
// Child mode: run.ts <dir> <safe|unsafe> <crash|resume>
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ToolResultMessage, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	ToolResultEntry,
	ToolTask,
	type ToolTaskInput,
} from "@earendil-works/pi-durable";
import { type CodemodeToolDetails, createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { emit, log, scratchDir } from "../../lib/experiment.ts";

type Mode = "safe" | "unsafe";
type Phase = "crash" | "resume";

// Step 2 of the unsafe scenario comes back as an error after the restart; the script catches it and goes on.
const SCRIPT = `
const clock = Date.now();
const random = Math.random();
const results = [];
for (const n of [1, 2, 3]) {
  try {
    results.push(await tools.step({ n, clock, random }));
  } catch (error) {
    results.push("step " + n + " failed: " + error.message);
  }
}
return { clock, random, results };
`;

async function child(directory: string, mode: Mode, phase: Phase): Promise<void> {
	const context = BACKGROUND_CONTEXT;
	const sideEffects = join(directory, "side-effects.log");
	const step = defineTool({
		name: "step",
		description: "Run one step",
		parameters: Type.Object({ n: Type.Number(), clock: Type.Number(), random: Type.Number() }),
		replay: mode === "safe" ? "safe" : undefined,
		execute: async (args) => {
			// The script passes its clock and random number along, so the log shows what the script saw in each process.
			appendFileSync(sideEffects, `${phase} process: step ${args.n} (seen ${args.clock}/${args.random})\n`);
			if (phase === "crash" && args.n === 2) process.exit(1);
			return { output: [{ type: "text", text: `step ${args.n} done` }] };
		},
	});
	const sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 });
	const registry = createRegistry();
	registry.install(createCodemodeExtension({ sandbox, models: false }));
	registry.install(defineExtension({ name: "steps", tools: [step] }));

	// The crash run needs the codemode call. The resume run only needs the final answer: the stored call is
	// recovered from storage, not requested from the model again.
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(
		phase === "crash"
			? [
					fauxAssistantMessage([fauxToolCall("codemode", { code: SCRIPT }, { id: "s1" })], {
						stopReason: "toolUse",
					}),
				]
			: [fauxAssistantMessage([fauxText("Done.")])],
	);

	const harness = await Harness.open(
		await openNodeSqliteStorage(join(directory, "session.sqlite")),
		{ models, registry },
		context,
	);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	// The same requestId in both processes: the resume run finds the submission the crash run made.
	const submission = await root.submit({ type: "input", content: "Run the steps", requestId: "steps-1" }, context);
	const settled = await submission.wait(context);
	const entries = await root.entries({}, 50, undefined, context);
	const message = [...entries.items].reverse().find((entry) => ToolResultEntry.is(entry))?.model?.[0] as
		| ToolResultMessage<CodemodeToolDetails>
		| undefined;
	const tasks = (await harness.commit((tx) => tx.scanTasks({ kind: ToolTask.definition.name }, 100), context)).items;
	await harness.close(context);
	await sandbox.close();
	const text = message?.content.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";
	process.stdout.write(
		JSON.stringify({
			submissionStatus: settled.status,
			codemodeResult: message && {
				isError: message.isError,
				// Without the wall time, which differs between runs.
				text: text.replace(/^Wall time .*\n/m, ""),
				calls: message.details?.calls.map((call) => `${call.name} ${call.args}: ${call.status}`),
			},
			nestedToolTasks: tasks.filter((task) => (task.input as ToolTaskInput).kind === "nested").length,
		}),
	);
}

function scenario(mode: Mode) {
	const directory = scratchDir(`codemode-${mode}`);
	const run = (phase: Phase) =>
		spawnSync(process.execPath, [import.meta.filename, directory, mode, phase], { encoding: "utf8" });
	const crash = run("crash");
	const resume = run("resume");
	if (resume.status !== 0) throw new Error(`resume failed: ${resume.stderr}`);
	const sideEffects = join(directory, "side-effects.log");
	const lines = existsSync(sideEffects) ? readFileSync(sideEffects, "utf8").trim().split("\n") : [];
	const seen = new Set(lines.map((line) => /\(seen (.*)\)/.exec(line)?.[1]));
	// The clock and the seed differ from run to run; the snapshot keeps placeholders so it stays comparable.
	let output = resume.stdout;
	const returned = /"clock\\":(\d+),\\"random\\":([\d.]+)/.exec(output);
	if (returned) output = output.replaceAll(returned[1], "<clock>").replaceAll(returned[2], "<random>");
	return {
		crashExitCode: crash.status,
		afterRestart: JSON.parse(output),
		sideEffects: lines.map((line) => line.replace(/ \(seen .*\)/, "")),
		// Each process logs the clock and random number its script passed, and the script returns them at the end: one
		// value in both processes, equal to the returned one, means the replay saw the same clock and randomness.
		sameClockAndRandomInBothProcesses:
			seen.size === 1 && returned !== null && [...seen][0] === `${returned[1]}/${returned[2]}`,
		runsPerStep: Object.fromEntries(
			[1, 2, 3].map((n) => [`step ${n}`, lines.filter((line) => line.includes(`step ${n} `)).length]),
		),
	};
}

if (process.argv.length > 2) {
	const [directory, mode, phase] = process.argv.slice(2);
	await child(directory, mode as Mode, phase as Phase);
	process.exit(0);
} else {
	const scenarios: Record<string, unknown> = {};
	for (const [name, mode] of [
		["step replay: safe", "safe"],
		["step replay: unsafe (default)", "unsafe"],
	] as const) {
		log(name);
		scenarios[name] = scenario(mode);
	}
	await emit(scenarios);
}
