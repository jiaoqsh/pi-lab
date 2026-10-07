// pi-lab release analyst, built on pi-durable: reads a tracking report (which experiments changed after a pi upgrade,
// with their snapshot diffs), sends one subagent per changed experiment to explain the change from pi's changelogs
// and draft a NOTES.md update, and writes a pull request summary.
//
//   node --env-file=.env analyst/analyze.ts --report report.md --from 1.0.0 --to 1.0.2
//
// State lives in SQLite (--storage, default .tmp/analyst/<from>-<to>.sqlite). If the process dies, run the same
// command again: the submission's requestId finds the earlier run, finished subagents are not run again, and
// unfinished ones continue.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import {
	AssistantEntry,
	configure,
	createRegistry,
	defineExtension,
	defineTool,
	type EntryId,
	Harness,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { loadExperiments, ROOT } from "../runner/core.ts";
import { commitDiff, extractSection, fetchChangelog, listCommits, PACKAGES, readSource } from "./sources.ts";

const { values: args } = parseArgs({
	options: {
		report: { type: "string" },
		from: { type: "string" },
		to: { type: "string" },
		storage: { type: "string" },
		out: { type: "string" },
		"lead-model": { type: "string", default: "deepseek-v4-pro" },
		"worker-model": { type: "string", default: "deepseek-flash" },
		/** Read NOTES.md as of this git revision, e.g. to replay an old upgrade without today's analysis in the notes. */
		"notes-rev": { type: "string" },
	},
});
if (!args.report || !args.from || !args.to) {
	throw new Error("usage: analyze.ts --report <report.md> --from <version> --to <version>");
}
const FROM = args.from;
const TO = args.to;
const report = readFileSync(args.report, "utf8");
const outDir = args.out ?? join(ROOT, ".tmp", "analyst", `${FROM}-${TO}`);
const storagePath = args.storage ?? join(ROOT, ".tmp", "analyst", `${FROM}-${TO}.sqlite`);
mkdirSync(outDir, { recursive: true });
mkdirSync(dirname(storagePath), { recursive: true });
const context = BACKGROUND_CONTEXT;
const experimentNames = loadExperiments().map((experiment) => experiment.name);

// ─── Tools shared by the lead and the workers ──────────────────────────────

const experimentParam = Type.String({ description: `One of: ${experimentNames.join(", ")}` });
function checkExperiment(name: string): string {
	if (!experimentNames.includes(name)) throw new Error(`Unknown experiment "${name}". Known: ${experimentNames.join(", ")}`);
	return name;
}

const readNotes = defineTool({
	name: "read_notes",
	description: "Read an experiment's NOTES.md: what it measures, its findings, and what to watch on upgrades.",
	parameters: Type.Object({ experiment: experimentParam }),
	replay: "safe",
	execute: async (input) => {
		const path = `experiments/${checkExperiment(input.experiment)}/NOTES.md`;
		const text = args["notes-rev"]
			? execFileSync("git", ["show", `${args["notes-rev"]}:${path}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
			: readFileSync(join(ROOT, path), "utf8");
		return { content: [{ type: "text", text }] };
	},
});

const changelog = defineTool({
	name: "changelog",
	description: `Changelog entries of one pi package for the releases after ${FROM} up to ${TO}, from GitHub.`,
	parameters: Type.Object({
		package: Type.String({ description: `One of: ${PACKAGES.join(", ")}` }),
	}),
	replay: "safe",
	execute: async (input) => {
		const text = await fetchChangelog(input.package, FROM, TO);
		return { content: [{ type: "text", text }] };
	},
});

const writeDraft = defineTool({
	name: "write_draft",
	description:
		"Save the proposed NOTES.md addition for an experiment (Markdown, starting with a `### Changed in <version>` heading). Overwrites an earlier draft.",
	parameters: Type.Object({ experiment: experimentParam, markdown: Type.String() }),
	replay: "safe",
	execute: async (input) => {
		const file = join(outDir, `${checkExperiment(input.experiment)}.md`);
		writeFileSync(file, `${input.markdown.trim()}\n`);
		return { content: [{ type: "text", text: `Saved draft to ${file.replace(`${ROOT}/`, "")}` }] };
	},
});

const commits = defineTool({
	name: "commits",
	description: `Commits between v${FROM} and v${TO} that touch one pi package: short sha and subject.`,
	parameters: Type.Object({ package: Type.String({ description: `One of: ${PACKAGES.join(", ")}` }) }),
	replay: "safe",
	execute: async (input) => ({ content: [{ type: "text", text: await listCommits(input.package, FROM, TO) }] }),
});

const commitDiffTool = defineTool({
	name: "commit_diff",
	description: "A commit's message and patch, optionally only for files under a path prefix such as packages/ai/src/.",
	parameters: Type.Object({ sha: Type.String(), path_prefix: Type.Optional(Type.String()) }),
	replay: "safe",
	execute: async (input) => ({ content: [{ type: "text", text: await commitDiff(input.sha, input.path_prefix) }] }),
});

const readSourceTool = defineTool({
	name: "read_source",
	description: `A file of the pi repository at a release tag, e.g. packages/ai/src/providers/faux.ts at ${TO}.`,
	parameters: Type.Object({ path: Type.String(), version: Type.String({ description: `e.g. ${FROM} or ${TO}` }) }),
	replay: "safe",
	execute: async (input) => ({ content: [{ type: "text", text: await readSource(input.path, input.version) }] }),
});

// ─── The subagent tool ─────────────────────────────────────────────────────

const WORKER_INSTRUCTIONS = `You analyze one pi-lab experiment after pi was upgraded from ${FROM} to ${TO}.
pi-lab runs experiments against pi's published packages; a key-free experiment's result is compared with its stored snapshot, so a diff means pi's behavior changed.
1. Call read_notes for the experiment to learn what it measures.
2. Call changelog for each pi package the experiment exercises.
3. Find the changelog entry that explains the diff. Quote it exactly and cite its commit or issue if given.
4. If the changelog does not explain the diff by itself, trace it in code: list the package's commits (commits), read the likely ones (commit_diff), and read the code they call into at both versions (read_source). A change can surface through code that did not change, for example when a new argument reaches an older function. Only state a cause you can point to in a diff or a source line, and quote that line; otherwise write "cause not found".
5. Call write_draft with a short NOTES.md addition: a "### Changed in ${TO}" heading, a table or list of what changed, and the cause.
6. Answer with three to five sentences: what changed, why, and whether it looks intended or like a regression.`;

async function answerText(api: ToolExecutionApi, answer: EntryId): Promise<string> {
	const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context);
	const message = entry?.model?.[0] as AssistantMessage | undefined;
	return message?.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("") ?? "";
}

const analyzeExperiment = defineTool({
	name: "analyze_experiment",
	description: "Have a subagent explain one changed or failed experiment from the changelogs and draft its NOTES.md update.",
	parameters: Type.Object({ experiment: experimentParam }),
	// A rerun finds the child conversation and the submission it made before a crash.
	replay: "safe",
	execute: async (input, api) => {
		const experiment = checkExperiment(input.experiment);
		const section = extractSection(report, experiment) ?? "(the report has no diff section for this experiment)";
		const child = await api.commit(async (tx) => {
			const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
			if (existing !== undefined) return existing.id;
			const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
			await configure(
				tx,
				created.id,
				{
					model: { provider: "deepseek", modelId: args["worker-model"]! },
					tools: [readNotes, changelog, commits, commitDiffTool, readSourceTool, writeDraft],
					instructions: WORKER_INSTRUCTIONS,
				},
			);
			return created.id;
		}, context);
		await api.details({ conversationId: child }, context);
		const handle = (await api.conversation(child, context))!;
		const prompt = `Experiment: ${experiment}\n\nIts section of the tracking report:\n\n${section}`;
		const submission = await handle.submit({ type: "input", content: prompt, requestId: `analyze:${api.taskId}` }, context);
		const settled = await submission.wait(context);
		if (settled.status !== "done" || settled.type !== "input") throw new Error(`subagent for ${experiment} ended: ${settled.status}`);
		return { content: [{ type: "text", text: await answerText(api, settled.answer) }], details: { conversationId: child } };
	},
});

// ─── The lead conversation ─────────────────────────────────────────────────

const LEAD_INSTRUCTIONS = `You maintain pi-lab, which tracks pi (earendil-works/pi) releases with experiments.
You get the tracking report for an upgrade from ${FROM} to ${TO}: a table of experiments with their status, and a diff for each one whose result changed.
1. Call analyze_experiment once for every experiment whose status is changed, updated, or failed, all in the same turn so they run in parallel. Skip unchanged ones.
2. Then write the pull request summary in Markdown: one "##" section per analyzed experiment with what changed, the cause from the changelog (or "cause not found"), and whether it looks intended. End with a short list of follow-ups for the maintainer of pi-lab. Do not invent changelog entries or commits.`;

const registry = createRegistry();
registry.install(
	defineExtension({
		name: "analyst",
		tools: [analyzeExperiment, readNotes, changelog, commits, commitDiffTool, readSourceTool, writeDraft],
	}),
);
const models = createModels();
models.setProvider(deepseekProvider());

const harness = await Harness.open(
	await openNodeSqliteStorage(storagePath),
	{ models, registry, settings: { toolExecution: "parallel" } },
	context,
);
const root = await harness.root(context, {
	agent: {
		model: { provider: "deepseek", modelId: args["lead-model"]! },
		tools: [analyzeExperiment],
		instructions: LEAD_INSTRUCTIONS,
	},
});
harness.resume(); // continue a run an earlier process left unfinished

const started = performance.now();
const submission = await root.submit(
	{ type: "input", content: `Tracking report (${FROM} -> ${TO}):\n\n${report}`, requestId: `release:${FROM}->${TO}` },
	context,
);
const settled = await submission.wait(context);
if (settled.status !== "done" || settled.type !== "input") throw new Error(`analysis ended: ${settled.status}`);
const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
const summary = (answer?.model?.[0] as AssistantMessage).content
	.flatMap((block) => (block.type === "text" ? [block.text] : []))
	.join("");
writeFileSync(join(outDir, "summary.md"), `${summary.trim()}\n`);
console.error(`done in ${Math.round((performance.now() - started) / 1000)} s; drafts and summary.md in ${outDir.replace(`${ROOT}/`, "")}`);
await harness.close(context);
