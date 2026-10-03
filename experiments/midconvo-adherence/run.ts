// After one English exchange, a mid-conversation system message asks for Chinese plus a trailing "DONE". Each model
// runs with that message sent in place and collapsed into the leading system prompt.
import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { emit, log, requireEnv, truncate } from "../../lib/experiment.ts";

requireEnv("DEEPSEEK_API_KEY");

const models = createModels();
models.setProvider(deepseekProvider());
const QUESTIONS = ["What is the capital of Germany?", "Name one planet with rings.", "What is 12 times 12?"];
const INSTRUCTION = "From now on, answer only in Chinese, and end every answer with the word DONE.";

const textOf = (message: AssistantMessage) =>
	message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();

async function trial(model: Model<Api>, question: string) {
	const messages: Message[] = [
		{ role: "system", content: "You are a helpful assistant. Answer in one short sentence.", timestamp: 0 },
		{ role: "user", content: "What is the capital of France?", timestamp: 1 },
	];
	messages.push(await models.complete(model, { messages }, { maxTokens: 300 }));
	messages.push({ role: "system", content: INSTRUCTION, timestamp: 2 });
	messages.push({ role: "user", content: question, timestamp: 3 });
	const answer = await models.complete(model, { messages }, { maxTokens: 300 });
	if (answer.stopReason === "error") return { pass: false, answer: `ERROR ${answer.errorMessage}` };
	const text = textOf(answer);
	return { pass: /[一-鿿]/.test(text) && /DONE\W*$/.test(text), answer: truncate(text, 80) };
}

const results: Record<string, unknown> = {};
for (const id of ["deepseek-flash", "deepseek-v4-pro"]) {
	const base = models.getModel("deepseek", id)!;
	for (const inPlace of [true, false]) {
		const label = `${id} ${inPlace ? "in place" : "collapsed"}`;
		log(label);
		const model = { ...base, compat: { ...base.compat, supportsMidConvoSystemMessages: inPlace } } as Model<Api>;
		const trials = await Promise.all(QUESTIONS.map((question) => trial(model, question)));
		results[label] = { passed: `${trials.filter((t) => t.pass).length}/${trials.length}`, trials };
	}
}
await emit({ instruction: INSTRUCTION, results });
