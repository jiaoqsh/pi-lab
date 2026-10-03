// One transcript with a mid-conversation system message, turned into each provider's request body.
// `onPayload` captures the body and aborts before anything is sent, so no API key or network is needed.
import { type Api, type AssistantMessage, type Context, type Model, Type } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { emit, log, truncate } from "../../lib/experiment.ts";

const read = { name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) };
const deploy = { name: "deploy", description: "Deploy a service", parameters: Type.Object({ service: Type.String() }) };

function assistant(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "It describes the project." }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

/** The prompt and tools are entries in the transcript. Only the first system message is "the system prompt". */
function transcript(model: Model<Api>): Context {
	return {
		messages: [
			{
				role: "system",
				content: "You are a coding assistant.",
				sections: { mode: "<mode>read-only</mode>" },
				toolsAdded: [read],
				timestamp: 0,
			},
			{ role: "user", content: "What is in README.md?", timestamp: 1 },
			assistant(model),
			// The change: replace the `mode` section, add an instruction, add a tool.
			{
				role: "system",
				content: "Deployments are now allowed.",
				sections: { mode: "<mode>deploy</mode>" },
				toolsAdded: [deploy],
				timestamp: 3,
			},
			{ role: "user", content: "Deploy the api.", timestamp: 4 },
		],
	};
}

const models = builtinModels();
function variant(provider: string, id: string, compat: Record<string, unknown> = {}): Model<Api> {
	const model = models.getModel(provider, id);
	if (!model) throw new Error(`${provider}/${id} is not in the catalog`);
	return { ...model, compat: { ...model.compat, ...compat } } as Model<Api>;
}

const VARIANTS: [string, Model<Api>][] = [
	["anthropic sonnet-5-5: native system + tool changes", variant("anthropic", "claude-sonnet-5-5")],
	[
		"anthropic sonnet-5-5: system messages only",
		variant("anthropic", "claude-sonnet-5-5", { supportsMidConvoToolChanges: false }),
	],
	[
		"anthropic sonnet-5-5: collapsed",
		variant("anthropic", "claude-sonnet-5-5", { supportsMidConvoSystemMessages: false, supportsMidConvoToolChanges: false }),
	],
	["openai gpt-5.5 (responses): additional_tools", variant("openai", "gpt-5.5")],
	["openai gpt-5.5 (responses): tool_search only", variant("openai", "gpt-5.5", { supportsAdditionalTools: false })],
	["moonshotai kimi-k2.6 (chat completions)", variant("moonshotai", "kimi-k2.6")],
	["deepseek deepseek-v4-pro (chat completions)", variant("deepseek", "deepseek-v4-pro")],
	["deepseek deepseek-flash (chat completions, default catalog)", variant("deepseek", "deepseek-flash")],
	["google gemini-2.5-flash (generative ai)", variant("google", "gemini-2.5-flash")],
];

type Json = Record<string, unknown>;

function text(value: unknown): string {
	return truncate(typeof value === "string" ? value : JSON.stringify(value), 200);
}

function toolName(tool: Json): string[] {
	const declarations = tool.functionDeclarations as { name: string }[] | undefined;
	if (declarations) return declarations.map((d) => d.name);
	const name = (tool.name ?? (tool.function as { name?: string } | undefined)?.name) as string;
	return [`${name}${tool.defer_loading ? " (defer_loading)" : ""}${tool.cache_control ? " [cache]" : ""}`];
}

/** One line per wire item, whatever the API calls its message list. */
function summarize(payload: Json) {
	const tools = (payload.tools ?? (payload.config as Json | undefined)?.tools ?? []) as Json[];
	const items = (payload.input ?? payload.messages ?? payload.contents) as Json[];
	const system = (payload.config as Json | undefined)?.systemInstruction ?? payload.system ?? payload.instructions;
	return {
		...(system ? { topLevelSystem: text(system) } : {}),
		tools: tools.flatMap(toolName),
		items: items.map((item) => {
			const kind = item.type && item.type !== "message" ? String(item.type) : String(item.role);
			const body = item.content ?? item.parts ?? item.tools ?? item.arguments;
			const extra = item.output_config ? ` output_config=${JSON.stringify(item.output_config)}` : "";
			return `${kind}: ${text(body)}${extra}`;
		}),
	};
}

const replayed = getCurrentSystemMessage(transcript(VARIANTS[0][1]).messages)!;
const requests: Record<string, unknown> = {};
for (const [label, model] of VARIANTS) {
	log(label);
	let payload: Json | undefined;
	await models.complete(model, transcript(model), {
		apiKey: "not-used",
		onPayload: (body) => {
			payload = body as Json;
			throw new Error("captured, not sent");
		},
	});
	requests[label] = payload ? summarize(payload) : "no payload captured";
}

await emit({
	replayedSystemMessage: { ...replayed, toolsAdded: replayed.toolsAdded?.map((tool) => tool.name) },
	requests,
});
