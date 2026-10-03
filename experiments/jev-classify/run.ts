// Ask Jev two typed questions about three prompts: the same call the virtual router makes before a session starts.
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { emit, log, requireEnv } from "../../lib/experiment.ts";

requireEnv("TYPESAFE_API_KEY");

const models = builtinModels();
const jev = models.getModelOfType("classifier", "typesafe", "jev-latest");
if (!jev) throw new Error("typesafe/jev-latest is not in the catalog");

const PROMPTS = [
	"Fix the typo in README.md: 'recieve' should be 'receive'.",
	"Redesign the session storage so that forks share history copy-on-write, migrate existing JSONL sessions, and keep resume working across versions.",
	"What does the --print flag do?",
];

const results = [];
for (const prompt of PROMPTS) {
	log(prompt);
	const started = performance.now();
	const result = await models.classify(jev, {
		state: { prompt },
		questions: {
			complexity: {
				type: "choice",
				instructions: "How demanding is the software engineering work requested in `prompt`?",
				criteria: {
					standard: "Ordinary features, fixes, reviews, or questions",
					complex: "Subtle design, cross-cutting changes, or hard debugging",
				},
			},
			edits_code: {
				type: "bool",
				instructions: "Does `prompt` ask for changes to code or files?",
				criteria: { true: "It asks to change code or files", false: "It only asks a question" },
			},
		},
	});
	results.push({
		prompt,
		latencyMs: Math.round(performance.now() - started),
		stopReason: result.stopReason,
		...(result.stopReason === "stop" ? { answers: result.answers, costUsd: result.usage?.cost.total } : { error: result.errorMessage }),
	});
}
await emit({ model: `${jev.provider}/${jev.id}`, results });
