// Drive CodemodeSandbox directly with two fake tools and record how each scenario ends.
import { CodemodeSandbox, type CodemodeResult, type CodemodeTool, renderDeclarations } from "@earendil-works/pi-codemode";
import { emit, log, truncate } from "../../lib/experiment.ts";

const TOOL_DELAY_MS = 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const tools: CodemodeTool[] = [
	{
		name: "mcp__linear__list_issues",
		description: "List issues of a Linear team",
		inputSchema: { type: "object", properties: { team: { type: "string" } }, required: ["team"] },
		outputSchema: {
			type: "array",
			items: {
				type: "object",
				properties: { id: { type: "string" }, title: { type: "string" }, priority: { type: "number" } },
			},
		},
		async execute(args) {
			const { team } = args as { team: string };
			await sleep(TOOL_DELAY_MS);
			return Array.from({ length: 5000 }, (_, i) => ({ id: `${team}-${i}`, title: `Issue ${i}`, priority: i % 5 }));
		},
	},
	{
		name: "notify",
		description: "Send a notification",
		inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		async execute(args) {
			const { text } = args as { text: string };
			if (text.includes("fail")) throw new Error("notification service is down");
			return "sent";
		},
	},
	{
		name: "searchLike",
		description: "Stands in for host functions such as searchTools() that resolve to a value",
		execute: () => [{ name: "notify" }],
	},
];

const sandbox = new CodemodeSandbox({ tools, timeoutMs: 1500, memoryLimitBytes: 64 * 1024 * 1024 });

/** What a scenario did, without timings or other run-to-run noise. */
function summarize(result: CodemodeResult) {
	return {
		ok: result.ok,
		...(result.ok
			? { value: result.value, storeWrites: result.storeWrites }
			: { error: { kind: result.error.kind, name: result.error.name, message: truncate(result.error.message, 240) } }),
		output: result.output.map((item) => (item.type === "text" ? truncate(item.text) : `<image ${item.mimeType}>`)),
		calls: result.calls.map((call) => `${call.name}:${call.status}`),
	};
}

const scenarios: Record<string, unknown> = {};
async function scenario(name: string, code: string, store: Record<string, unknown> = {}) {
	log(`scenario ${name}`);
	const started = performance.now();
	const result = await sandbox.execute(code, { store });
	scenarios[name] = summarize(result);
	return { result, ms: performance.now() - started };
}

// Two 1 s calls in Promise.all: parallel if the script ends well before the 2 s two sequential calls would take.
const parallel = await scenario(
	"parallel-and-filter",
	`const [a, b] = await Promise.all([
		tools.mcp__linear__list_issues({ team: "ENG" }),
		tools.mcp__linear__list_issues({ team: "OPS" }),
	]);
	const urgent = [...a, ...b].filter((issue) => issue.priority === 4);
	return { rowsSeenInSandbox: a.length + b.length, urgent: urgent.length, sample: urgent.slice(0, 2).map((i) => i.id) };`,
);
const ranInParallel = parallel.ms < TOOL_DELAY_MS * 1.8;
log(`parallel scenario took ${Math.round(parallel.ms)} ms`);

const first = await scenario(
	"store-write",
	`const issues = await tools.mcp__linear__list_issues({ team: "ENG" }); store("cursor", issues[99].id); return "stored";`,
);
await scenario(
	"store-load-next-execution",
	`return "resume after " + load("cursor");`,
	first.result.ok ? first.result.storeWrites.set : {},
);
await scenario("typo-in-tool-name", `return await tools.Notify({ text: "hi" });`);
await scenario(
	"allSettled-partial-failure",
	`const results = await Promise.allSettled([tools.notify({ text: "deploy started" }), tools.notify({ text: "please fail" })]);
	return results.map((r) => (r.status === "fulfilled" ? r.value : "error: " + r.reason.message));`,
);
await scenario(
	"uncaught-error-keeps-output",
	`await tools.notify({ text: "step 1" }); console.log("step 1 done"); await tools.notify({ text: "now fail" }); console.log("never printed");`,
);
await scenario(
	"isolation",
	`return { process: typeof process, fetch: typeof fetch, setTimeout: typeof setTimeout, require: typeof require };`,
);
await scenario("stalled-promise", `await new Promise(() => {}); return "unreachable";`);
await scenario("infinite-loop-hits-timeout", `console.log("spinning"); while (true) {}`);
await scenario("memory-limit", `const big = []; while (true) big.push("x".repeat(1024 * 1024));`);
// Missing await: a promise serialized to JSON. pi 1.0 yields "{}" silently.
await scenario("missing-await-stringify", `const found = tools.searchLike({}); return JSON.stringify(found);`);
// `tools` is a parameter of the function the script runs in.
await scenario("declare-tools-variable", `const tools = 1; return tools;`);
// Patching a built-in: before pi 1.0.4 this could crash the host (#10444); 1.0.4 freezes built-ins first.
await scenario(
	"patch-builtin",
	`Array.prototype.toJSON = () => "patched";
	return { stringified: JSON.stringify([1, 2]), patched: Object.isFrozen(Array.prototype) ? "frozen" : "writable" };`,
);

await sandbox.close();
await emit({
	declarations: renderDeclarations({ tools }).split("\n"),
	ranInParallel,
	scenarios,
});
