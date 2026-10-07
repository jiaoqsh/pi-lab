// Two requests to pi-ai's faux provider, the second one extending the first, with and without a sessionId. With a
// sessionId the faux provider simulates prompt caching. The prompt it reports (input + cacheRead + cacheWrite) should
// equal its own estimate of the prompt, as it does without a sessionId.
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { emit } from "../../lib/experiment.ts";

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = models.getModel("faux", "faux-1")!;

const results: Record<string, unknown> = {};
for (const sessionId of [undefined, "session-1"]) {
	faux.setResponses([fauxAssistantMessage([fauxText("ok")]), fauxAssistantMessage([fauxText("ok")])]);
	const messages: Message[] = [{ role: "user", content: "x".repeat(4000), timestamp: 0 }];
	const first = await models.complete(model, { messages }, { sessionId });
	messages.push(first, { role: "user", content: "y".repeat(400), timestamp: 1 });
	const second = await models.complete(model, { messages }, { sessionId });
	results[sessionId ? "with sessionId" : "without sessionId"] = Object.fromEntries(
		(
			[
				["first request", first],
				["second request (extends the first)", second],
			] as const
		).map(([label, message]) => {
			const { input, cacheRead, cacheWrite, output, totalTokens } = message.usage;
			return [label, { input, cacheRead, cacheWrite, output, totalTokens, promptCounted: input + cacheRead + cacheWrite }];
		}),
	);
}
await emit(results);
