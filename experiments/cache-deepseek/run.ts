// Per strategy: a fresh nonce leads the system prompt (no cache sharing between strategies), a warm-up request
// writes the cache, and the follow-up after a mid-conversation change reports how many prompt tokens hit the cache.
import { type Api, type Context, type Message, type Model, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { emit, log, requireEnv } from "../../lib/experiment.ts";

requireEnv("DEEPSEEK_API_KEY");

const read = { name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) };
const deploy = { name: "deploy", description: "Deploy a service", parameters: Type.Object({ service: Type.String() }) };

// About 2k tokens each, so "system only" and "system + conversation" hits are easy to tell apart.
const filler = (topic: string, n: number) =>
	Array.from({ length: n }, (_, i) => `${topic} rule ${i}: keep answers short, cite file paths, prefer small diffs.`).join("\n");
const SYSTEM = filler("Style", 110);
const USER_1 = `Here is some context you can ignore:\n${filler("Context", 110)}\nReply with just OK.`;

const models = createModels();
models.setProvider(deepseekProvider());
const flash = models.getModel("deepseek", "deepseek-flash")!;
const withCompat = (compat: Record<string, unknown>) => ({ ...flash, compat: { ...flash.compat, ...compat } }) as Model<Api>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const strategies: { label: string; change: "none" | "text" | "tool"; model: Model<Api> }[] = [
	{ label: "baseline: no change", change: "none", model: flash },
	{ label: "prompt change in place (mid-conversation system message)", change: "text", model: withCompat({ supportsMidConvoSystemMessages: true }) },
	{ label: "prompt change collapsed into the leading system message", change: "text", model: withCompat({ supportsMidConvoSystemMessages: false }) },
	{ label: "tool added (no native tool additions: tool list resent)", change: "tool", model: withCompat({ supportsMidConvoSystemMessages: true }) },
];

async function ask(model: Model<Api>, messages: Message[]) {
	const response = await models.complete(model, { messages } satisfies Context, { maxTokens: 20 });
	if (response.stopReason === "error") throw new Error(response.errorMessage);
	return response;
}

const rows: Record<string, unknown> = {};
for (const strategy of strategies) {
	log(strategy.label);
	const nonce = Math.random().toString(36).slice(2);
	const messages: Message[] = [
		{ role: "system", content: `Session ${nonce}.\n${SYSTEM}`, toolsAdded: [read], timestamp: 0 },
		{ role: "user", content: USER_1, timestamp: 1 },
	];
	const warm = await ask(strategy.model, messages);
	messages.push(warm);
	if (strategy.change !== "none") {
		messages.push({
			role: "system",
			content: "Deployments are now allowed.",
			...(strategy.change === "tool" ? { toolsAdded: [deploy] } : {}),
			timestamp: 2,
		});
	}
	messages.push({ role: "user", content: "Reply with just OK again.", timestamp: 3 });
	await sleep(3000); // DeepSeek builds its cache asynchronously
	const follow = await ask(strategy.model, messages);
	const prompt = follow.usage.input + follow.usage.cacheRead;
	rows[strategy.label] = {
		followUpPromptTokens: prompt,
		cacheHitTokens: follow.usage.cacheRead,
		hitPercent: Math.round((100 * follow.usage.cacheRead) / prompt),
	};
}
await emit({ model: "deepseek/deepseek-flash", strategies: rows });
