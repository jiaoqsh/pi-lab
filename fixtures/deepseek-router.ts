/**
 * router/auto: a virtual model adapted from pi's examples/extensions/jev-router.ts to DeepSeek.
 *
 * - First request of a session: Jev rates the user message; complex -> deepseek-v4-pro, standard -> deepseek-flash.
 * - After the first successful edit/write in the planning phase, switch to deepseek-flash once and stay there.
 * - Direct requests (compaction summaries and the like) go to deepseek-flash.
 *
 * The phase is router state: pi stores it on the session branch as a `pi.virtual-model-state` entry.
 */
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

const PRO = "deepseek-v4-pro";
const FLASH = "deepseek-flash";
const EDIT_TOOLS = new Set(["edit", "write"]);

interface RouterState {
	phase: "planning" | "implementation";
	model: string;
	/** Jev's probability that the first request is complex, kept for inspection. */
	complex?: number;
}

type Request = ModelRouteRequest<RouterState>;

function routeTo(request: Request, ctx: ExtensionContext, id: string, state?: RouterState): ModelRoute<RouterState> {
	const model = ctx.modelRegistry.find("deepseek", id);
	if (!model) throw new Error(`Model deepseek/${id} is not in the catalog`);
	return { model, thinkingLevel: request.thinkingLevel, state };
}

function lastUserText(messages: readonly Message[]): string {
	const content = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function editedThisTurn(messages: readonly Message[]): boolean {
	const lastUser = messages.findLastIndex((message) => message.role === "user");
	return messages
		.slice(lastUser + 1)
		.some((message) => message.role === "toolResult" && EDIT_TOOLS.has(message.toolName) && !message.isError);
}

async function rateComplexity(request: Request, ctx: ExtensionContext): Promise<number | undefined> {
	const jev = ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest");
	if (!jev) return undefined;
	const result = await ctx.modelRegistry.classify(
		jev,
		{
			state: { prompt: lastUserText(request.messages).slice(0, 16_000) },
			questions: {
				complexity: {
					type: "choice",
					instructions: "How demanding is the software engineering work requested in `prompt`?",
					criteria: {
						standard: "Ordinary features, fixes, reviews, or questions",
						complex: "Subtle design, cross-cutting changes, or hard debugging",
					},
				},
			},
		},
		{ signal: request.signal },
	);
	const answer = result.stopReason === "stop" ? result.answers.complexity : undefined;
	return answer?.type === "choice" ? (answer.probabilities.complex ?? 0) : undefined;
}

export default function (pi: ExtensionAPI) {
	pi.registerVirtualModel<RouterState>({
		provider: "router",
		id: "auto",
		name: "Auto (Jev + DeepSeek)",
		thinkingLevels: ["low", "high"],
		async route(request, ctx) {
			if (request.reason === "direct") return routeTo(request, ctx, FLASH);
			const state = request.state;
			if (!state) {
				const complex = await rateComplexity(request, ctx);
				const id = complex !== undefined && complex >= 0.5 ? PRO : FLASH;
				return routeTo(request, ctx, id, { phase: "planning", model: id, complex });
			}
			if (state.phase === "planning" && state.model === PRO && editedThisTurn(request.messages)) {
				return routeTo(request, ctx, FLASH, { ...state, phase: "implementation", model: FLASH });
			}
			return routeTo(request, ctx, state.model);
		},
	});
}
