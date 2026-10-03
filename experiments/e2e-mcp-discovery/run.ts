// The shop MCP server's tools are not declared to the model: with `codemode` exposure (default) scripts find them
// with searchTools()/ALL_TOOLS; with `deferred` exposure the model loads them with tool_search. Records how each run
// got there and what it cost. Results vary between runs; they are recorded, not compared.
import { emit, log, requireEnv, scratchDir, truncate } from "../../lib/experiment.ts";
import { createAgentDir, messagesOf, type PiRun, runPi, textOf, usageOf } from "../../lib/pi-cli.ts";

requireEnv("DEEPSEEK_API_KEY");

const LOOKUP = "Using the shop backend, look up customer C16 and tell me their tier.";
const REFUNDS =
	"Using the shop backend: what is the total USD amount of refunded orders, and which customer (name and tier) has the largest refunded total?";

interface Case {
	name: string;
	model: string;
	exposure: "codemode" | "deferred";
	prompt: string;
	correct: (answer: string) => boolean;
}

const lookupCorrect = (answer: string) => /basic/i.test(answer);
// 600 refunded orders, $152,100 total; C16 and C36 tie at $19,575.
const refundsCorrect = (answer: string) => /152,?100/.test(answer) && /(C|Customer )16/.test(answer);

const cases: Case[] = [];
for (const model of ["deepseek-flash", "deepseek-v4-pro"]) {
	for (const run of [1, 2]) {
		cases.push({ name: `lookup codemode ${model} #${run}`, model, exposure: "codemode", prompt: LOOKUP, correct: lookupCorrect });
	}
	cases.push({ name: `lookup tool_search ${model}`, model, exposure: "deferred", prompt: LOOKUP, correct: lookupCorrect });
}
cases.push({
	name: "refunds codemode deepseek-v4-pro",
	model: "deepseek-v4-pro",
	exposure: "codemode",
	prompt: REFUNDS,
	correct: refundsCorrect,
});

function describe(testCase: Case, run: PiRun) {
	const assistants = messagesOf(run, "assistant");
	const results = messagesOf(run, "toolResult");
	const steps = assistants.flatMap((message) =>
		typeof message.content === "string"
			? []
			: message.content
					.filter((block) => block.type === "toolCall")
					.map((block) => (block.name === "codemode" ? `codemode: ${truncate(String(block.arguments?.code ?? ""), 120)}` : `${block.name}(${truncate(JSON.stringify(block.arguments), 80)})`)),
	);
	const codemodeResults = results.filter((message) => message.toolName === "codemode").map(textOf);
	const answer = assistants.length ? textOf(assistants.at(-1)!) : "";
	return {
		exposure: testCase.exposure,
		model: testCase.model,
		exitCode: run.exitCode,
		correct: testCase.correct(answer),
		...usageOf(run),
		steps,
		// Symptoms of the missing-await problem: pi 1.0 prints "{}" for a serialized promise.
		emptyObjectResults: codemodeResults.filter((text) => /Output:\n\{\}\s*$/.test(text)).length,
		parameterRedefinitionErrors: codemodeResults.filter((text) => text.includes("redefinition of parameter")).length,
		truncatedOutputs: codemodeResults.filter((text) => text.includes("truncated output")).length,
		// tool_search loads tools by appending a system message with toolsAdded to the transcript.
		toolsAddedMidConversation: run.session
			.filter((entry) => entry.type === "message" && entry.message?.role === "system")
			.slice(1)
			.flatMap((entry) => entry.message?.toolsAdded?.map((tool) => tool.name) ?? []),
		answer: truncate(answer, 300),
	};
}

const runs = await Promise.all(
	cases.map(async (testCase) => {
		const agentDir = createAgentDir(testCase.name.replaceAll(/\W+/g, "-"), { shopExposure: testCase.exposure });
		const run = await runPi(agentDir, scratchDir("cwd"), ["--model", `deepseek/${testCase.model}`], testCase.prompt);
		log(`${testCase.name}: exit ${run.exitCode}`);
		return [testCase.name, describe(testCase, run)] as const;
	}),
);
await emit(Object.fromEntries(runs));
