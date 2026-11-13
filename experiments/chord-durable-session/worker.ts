// A session's worker process, forked by the server's route: run as `worker.ts <session> <dir>`.
// One store (<dir>/<session>.sqlite) holds everything the session has: Durable's records (through StoreStorage) and
// Chord's own table. The Agent object opens the Harness; Chat objects re-expose its transcript per principal.
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { constant, createHost, defineFacet, ipcLink, openStore, sqliteBackend } from "@earendil-works/chord";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	defineExtension,
	defineTool,
	type EntryRecord,
	Harness,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { StoreStorage } from "@earendil-works/pi-durable/storage/store";
import { obj as toolObj, str as toolStr } from "@earendil-works/pi-schema";
import { Agent, Audit, Chat, type P, SessionHost } from "./core.ts";

const [session, directory] = process.argv.slice(2);
if (session === undefined || directory === undefined || process.send === undefined) {
	throw new Error("usage: worker.ts <session> <dir>, forked with an IPC channel");
}
const context = BACKGROUND_CONTEXT;
const sideEffects = join(directory, "side-effects.log");
const gate = join(directory, "step-3.gate");
const committed = join(directory, "committed.log");

// Make the link first: it queues the server's messages until the host listens.
const link = ipcLink(process as Parameters<typeof ipcLink>[0]);

// The scripted model: a tool call for the request, a short answer once the tool result is in the context.
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const answer = (ctx: { messages: readonly Message[] }) =>
	ctx.messages.at(-1)?.role === "toolResult"
		? fauxAssistantMessage([fauxText("Deployed api.")])
		: fauxAssistantMessage([fauxToolCall("deploy", { service: "api" }, { id: "d1" })], { stopReason: "toolUse" });
faux.setResponses([answer, answer, answer, answer]);

function line(entry: EntryRecord): { kind: string; text: string } {
	const parts: string[] = [];
	for (const message of entry.model ?? []) {
		if (typeof message.content === "string") parts.push(message.content);
		else
			for (const part of message.content) {
				if (part.type === "text") parts.push(part.text);
				else if (part.type === "toolCall") parts.push(`call ${part.name}(${JSON.stringify(part.arguments)})`);
			}
	}
	return { kind: entry.kind, text: parts.join(" ").trim() };
}

const facet = defineFacet<P>((host) => {
	host.serve(Agent, (_params, self) => {
		const audit = self.table(Audit);
		const deploy = defineTool({
			name: "deploy",
			description: "Deploy the service in three steps",
			parameters: toolObj({ service: toolStr() }),
			// A promise from the tool author: rerunning execute() is safe, because finished steps are memoized.
			replay: "safe",
			execute: async (args, api, callContext) => {
				for (const step of [1, 2, 3]) {
					if (await api.memo<boolean>(`step-${step}`, callContext)) {
						api.output(`step ${step}: skipped (memo)\n`);
						continue;
					}
					// The run holds step 3 back until it has killed the first worker, so the crash lands between 2 and 3.
					if (step === 3) while (!existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 10));
					appendFileSync(sideEffects, `${process.pid} ${args.service} step ${step}\n`); // the outside world
					await self.tx(async (tx) => tx.put(audit, { step, pid: process.pid }), callContext); // a Chord row
					await api.memo(`step-${step}`, true, callContext); // a Durable record, same store
					appendFileSync(committed, `${step}\n`); // tells the run this step is in the store
					api.output(`step ${step}: done\n`);
				}
				return {};
			},
		});
		const harness = self.open(
			async (open) => {
				const registry = createRegistry();
				registry.install(defineExtension({ name: "ops", tools: [deploy] }));
				// Durable's records under the Agent's type name, in the worker's store.
				const opened = await Harness.open(await StoreStorage.open(store, Agent.name, open), { models, registry }, open);
				await opened.root(open, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
				// Work a dead process left stays pending until the scheduler starts: a worker that reopens a session
				// has to start it, or the interrupted tool call waits for the next submit.
				opened.resume();
				return opened;
			},
			(h, _reason, close) => h.close(close),
		);
		// Durable's view of the root conversation as a Chord source: every commit of the view is one Chord change.
		const view = self.follow((observer, ctx) => harness.value.observeConversation(ROOT_CONVERSATION_ID, observer, ctx));
		return {
			transcript: self.derive([view], ([v]) => ({ entries: v.entries.map(line) })),
			send: async ({ text }, ctx) => {
				const root = await harness.value.conversation(ROOT_CONVERSATION_ID, ctx);
				await root?.submit({ type: "input", content: text }, ctx);
				return null;
			},
		};
	});
	// One view per (session, principal): the owner may send, a viewer only reads.
	host.serve(Chat, (_params, principal, self) => {
		const agent = self.get(Agent, {});
		const worker = constant({ pid: process.pid });
		if (principal.kind === "owner") {
			return {
				variant: "owner",
				members: { transcript: agent.transcript, worker, send: (args, ctx) => agent.send(args, ctx) },
			};
		}
		return { variant: "viewer", members: { transcript: agent.transcript, worker } };
	});
});

const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(join(directory, `${session}.sqlite`))), context);
const host = createHost<P>({
	address: SessionHost({ id: session }),
	principal: { kind: "worker", session },
	store,
	onError: (error) => console.error(`[worker ${session}]`, error.kind),
});
host.connect(link, { principal: { kind: "server" }, trusted: true }, context);
await host.load([{ name: "@lab/session", facet }], context);

process.on("disconnect", () => {
	void host
		.close(context)
		.then(() => store.close(context))
		.finally(() => process.exit(0));
});
