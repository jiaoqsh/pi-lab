// Layers 4 and 5 together, the shape of Earendil's p3 in miniature: a server host routes Chat { session } to a
// worker process per session; each worker opens Durable's Harness on its own Chord store (StoreStorage), next to a
// Chord table; clients see the agent's transcript through Chord references that follow Durable's view.
//
//   owner, viewer ── memory links ──▶ server ── route Session → fork worker.ts, IPC ──▶ worker s1: Agent (Harness) + s1.sqlite
//
// The scenario: the owner asks for a deploy; the model calls a three-step tool; the worker is SIGKILLed between steps
// 2 and 3; the route forks the session again, Durable resumes the tool task (memos skip steps 1 and 2) and the model
// answers; both clients' references follow across the crash without retry code.
import { fork } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type Address,
	createHost,
	type Host,
	isChordError,
	ipcLink,
	memoryLinkPair,
	openStore,
	type Reference,
	type RefState,
	sqliteBackend,
} from "@earendil-works/chord/next";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { StoreStorage } from "@earendil-works/pi-durable/storage/store";
import { emit, log, scratchDir } from "../../lib/experiment.ts";
import { Agent, Chat, type P, Server, SessionHost } from "./core.ts";

const context = BACKGROUND_CONTEXT;
const directory = scratchDir("chord-durable-session");
const sideEffects = join(directory, "side-effects.log");
const errors: string[] = [];
const onError = (who: string) => (error: { kind: string }) => {
	errors.push(`${who}: ${error.kind}`);
	log(`[${who}]`, error.kind);
};

// --- server --------------------------------------------------------------------------------------------------------
const server = createHost<P>({ address: Server(), principal: { kind: "server" }, onError: onError("server") });
const pids: number[] = [];
const children = new Map<string, ReturnType<typeof fork>>();
server.route(
	SessionHost,
	{
		authorize: (principal: P, address: Address<typeof SessionHost>) =>
			principal.kind === "owner" || (principal.kind === "viewer" && principal.session === address.params.id),
		resolve: async (address: Address<typeof SessionHost>) => {
			const session = address.params.id;
			const child = fork(join(import.meta.dirname, "worker.ts"), [session, directory], {
				serialization: "advanced",
				stdio: ["ignore", "ignore", "inherit", "ipc"],
			});
			children.set(session, child);
			pids.push(child.pid ?? -1);
			log(`server: forked worker ${session} (pid ${child.pid})`);
			return { link: ipcLink(child), principal: { kind: "worker", session }, trusted: true };
		},
	},
	context,
);
await server.load([], context);

// --- clients -------------------------------------------------------------------------------------------------------
async function client(principal: P): Promise<Host<P>> {
	const host = createHost<P>({ onError: onError(principal.kind) });
	const [atServer, atClient] = memoryLinkPair();
	server.accept(atServer, { principal }, context);
	host.connect(atClient, { principal: { kind: "server" } }, context);
	await host.load([], context);
	return host;
}
const owner = await client({ kind: "owner" });
const viewer = await client({ kind: "viewer", session: "s1" });

function until<T>(read: () => T, done: (value: T) => boolean, label: string, ms = 30_000): Promise<T> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			const value = read();
			if (done(value)) resolve(value);
			else if (Date.now() - started > ms) reject(new Error(`timed out waiting for ${label}`));
			else setTimeout(tick, 10);
		};
		tick();
	});
}
const effects = () => (existsSync(sideEffects) ? readFileSync(sideEffects, "utf8").trim().split("\n") : []);
/** Pids differ per run: name them by fork order. */
const named = (text: string) => pids.reduce((t, pid, i) => t.replaceAll(String(pid), `worker#${i + 1}`), text);

type OwnerChat = Extract<Reference<typeof Chat>, { variant: "owner" }>;
const result: Record<string, unknown> = {};

// 1. Both clients hold Chat { s1 }; the server routes the address to a fresh worker.
const ownerChat = await owner.get(Chat, { session: "s1" }, context);
const viewerChat = await viewer.get(Chat, { session: "s1" }, context);
if (ownerChat.variant !== "owner") throw new Error("the owner should get the owner variant");
const ownerStates: RefState["kind"][] = [ownerChat.state.value.kind];
const viewerStates: RefState["kind"][] = [viewerChat.state.value.kind];
const ownerStateWatch = await ownerChat.state.watch(context);
const viewerStateWatch = await viewerChat.state.watch(context);
const viewerTranscriptWatch = await viewerChat.transcript.watch(context);
ownerStateWatch.start(async (call) => {
	if (call.kind === "value" && ownerStates.at(-1) !== call.value.kind) ownerStates.push(call.value.kind);
});
viewerStateWatch.start(async (call) => {
	if (call.kind === "value" && viewerStates.at(-1) !== call.value.kind) viewerStates.push(call.value.kind);
});
const viewerKinds: string[] = [];
viewerTranscriptWatch.start(async (call) => {
	if (call.kind === "value") viewerKinds.push(call.value.entries.map((e) => e.kind).join(","));
});
let viewerSend: unknown = "accepted";
try {
	await (viewerChat as unknown as OwnerChat).send({ text: "deploy it twice" }, context);
} catch (error) {
	viewerSend = isChordError(error) ? { code: error.code, reason: error.reason ?? null } : String(error);
}
result["1. owner and viewer hold Chat { s1 }"] = {
	ownerVariant: ownerChat.variant,
	viewerVariant: viewerChat.variant,
	viewerSend,
	sameWorker: ownerChat.worker.value.pid === viewerChat.worker.value.pid,
};

// 2. The owner asks; the model calls deploy; the worker dies after step 2.
await ownerChat.send({ text: "Deploy api" }, context);
await until(effects, (lines) => lines.length === 2, "steps 1 and 2");
const beforeCrash = viewerChat.transcript.value.entries;
const firstPid = ownerChat.worker.value.pid;
children.get("s1")?.kill("SIGKILL");
writeFileSync(join(directory, "step-3.gate"), ""); // only now may step 3 run, in whichever process is alive
result["2. worker killed between steps 2 and 3"] = {
	sideEffects: effects().map(named),
	viewerTranscriptAtCrash: beforeCrash.map((e) => e.kind),
};

// 3. Nothing in the clients retries: the route forks s1 again, the Harness reopens on s1.sqlite and resumes the task.
await until(() => ownerChat.worker.value.pid, (pid) => pid !== firstPid, "a new worker s1");
const transcript = await until(
	() => viewerChat.transcript.value.entries,
	(entries) => entries.at(-1)?.text === "Deployed api.",
	"the model's answer",
);
result["3. after the restart"] = {
	ownerReferenceStates: ownerStates,
	viewerReferenceStates: viewerStates,
	forks: pids.length,
	// Each step ran once, across two processes.
	sideEffects: effects().map(named),
	transcript: transcript.map((e) => ({ kind: e.kind, text: named(e.text) })),
	ownerSeesTheSame: JSON.stringify(ownerChat.transcript.value.entries) === JSON.stringify(transcript),
	viewerWatchLatest: viewerKinds.at(-1) ?? null,
};

for (const watch of [ownerStateWatch, viewerStateWatch, viewerTranscriptWatch]) watch.stop();
await owner.close(context);
await viewer.close(context);
await server.close(context);
for (const child of children.values()) child.kill();
await until(() => [...children.values()].every((c) => c.exitCode !== null || c.signalCode !== null), Boolean, "exit");

// 4. One store per session: reopen s1.sqlite and read both layers from one archive.
const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(join(directory, "s1.sqlite"))), context);
const rowsByTable = new Map<string, number>();
const documentOwners = new Set<string>();
const auditRows: unknown[] = [];
for await (const part of store.export(context)) {
	if (part.kind === "table") rowsByTable.set(part.table, rowsByTable.get(part.table) ?? 0);
	if (part.kind === "put") rowsByTable.set(part.table, (rowsByTable.get(part.table) ?? 0) + 1);
	if (part.kind === "document.create") documentOwners.add(part.record.owner);
	if (part.kind === "put" && part.table.endsWith("deploy.audit")) auditRows.push(part.row);
}
const storage = await StoreStorage.open(store, Agent.name, context);
const page = await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 50, undefined, context);
await storage.close(context);
await store.close(context);
result["4. s1.sqlite after shutdown"] = {
	tables: [...rowsByTable.keys()].sort(),
	documentOwners: [...documentOwners],
	auditRows: auditRows.map((row) => named(JSON.stringify(row))),
	durableEntries: [...page.items].reverse().map((entry) => entry.kind),
};

result.hostErrors = errors;
await emit(result);
