// Run the copied official pi-durable examples against the published packages and record their printed output.
// The examples use the faux provider when OPENAI_API_KEY is unset, which keeps their output deterministic.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { emit, log, scratchDir } from "../../lib/experiment.ts";

const EXAMPLES = ["20-inbox", "23-subagent-background", "25-compaction"];
const { OPENAI_API_KEY: _openaiKey, ...env } = process.env;

const outputs: Record<string, string[]> = {};
for (const name of EXAMPLES) {
	log(name);
	const result = spawnSync(process.execPath, [join(import.meta.dirname, "examples", `${name}.ts`)], {
		encoding: "utf8",
		env,
		cwd: scratchDir(name),
	});
	if (result.status !== 0) throw new Error(`${name} failed:\n${result.stderr}`);
	// Temporary paths differ per run; keep only their role.
	outputs[name] = result.stdout
		.trimEnd()
		.split("\n")
		.map((line) => line.replace(/\/[^\s"']*pi-durable[^\s"']*/g, "<tmp>"));
}
await emit(outputs);
