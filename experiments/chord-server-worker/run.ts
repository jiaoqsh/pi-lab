// The smallest Chord v2 app with p3's shape: one server host, one worker process per project (forked on demand by
// the server's route, linked over IPC), and two client hosts (an owner and a guest) connected to the server.
//
//   clients (owner, guest) ── memory links ──▶ server ── route Project → fork worker.ts, IPC link ──▶ worker p1, p2
//
// Scenarios: routing by address, principals and variants, a client watching a worker's commits through the relay,
// one process per project, authorization at the route, and a worker crash followed by a re-resolve that finds the
// persisted notes again.
import { fork } from "node:child_process";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type Address,
	createHost,
	type Host,
	ipcLink,
	isChordError,
	memoryLinkPair,
	type Reference,
	type RefState,
} from "@earendil-works/chord";
import { emit, log, scratchDir } from "../../lib/experiment.ts";
import { Notes, type P, Project, Server } from "./core.ts";

const context = BACKGROUND_CONTEXT;
const directory = scratchDir("chord-server-worker");
const errors: string[] = [];
const onError = (who: string) => (error: { kind: string }) => {
	errors.push(`${who}: ${error.kind}`);
	log(`[${who}]`, error.kind);
};

// --- server --------------------------------------------------------------------------------------------------------
const server = createHost<P>({ address: Server(), principal: { kind: "server" }, onError: onError("server") });
const forks: { project: string; pid: number }[] = [];
const children = new Map<string, ReturnType<typeof fork>>();
server.route(
	Project,
	{
		// Every hold routed to a project passes here first, with the principal the client's link stamped.
		authorize: (principal: P, address: Address<typeof Project>) =>
			principal.kind === "owner" || (principal.kind === "guest" && principal.project === address.params.id),
		// Called when a held address has no link: start the project's worker and link to it.
		resolve: async (address: Address<typeof Project>) => {
			const project = address.params.id;
			const child = fork(join(import.meta.dirname, "worker.ts"), [project, directory], {
				serialization: "advanced",
				stdio: ["ignore", "ignore", "inherit", "ipc"],
			});
			children.set(project, child);
			forks.push({ project, pid: child.pid ?? -1 });
			log(`server: forked worker ${project} (pid ${child.pid})`);
			return { link: ipcLink(child), principal: { kind: "worker", project }, trusted: true };
		},
	},
	context,
);
await server.load([], context);

// --- clients -------------------------------------------------------------------------------------------------------
async function client(principal: P): Promise<Host<P>> {
	const host = createHost<P>({ onError: onError(principal.kind) });
	const [atServer, atClient] = memoryLinkPair();
	server.accept(atServer, { principal }, context); // the server says who this client is
	host.connect(atClient, { principal: { kind: "server" } }, context);
	await host.load([], context);
	return host;
}
const owner = await client({ kind: "owner" });
const guest = await client({ kind: "guest", project: "p1" });

function until<T>(read: () => T, done: (value: T) => boolean, label: string, ms = 20_000): Promise<T> {
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

const result: Record<string, unknown> = {};
type Editor = Extract<Reference<typeof Notes>, { variant: "editor" }>;

// 1. Routing and variants: both clients ask for Notes { p1 }; the server routes by address to worker p1.
const ownerP1 = await owner.get(Notes, { project: "p1" }, context);
const guestP1 = await guest.get(Notes, { project: "p1" }, context);
const guestSeen: string[][] = [];
const guestWatch = await guestP1.list.watch(context);
guestWatch.start(async (call) => {
	if (call.kind === "value") guestSeen.push([...call.value.items]);
});
if (ownerP1.variant !== "editor") throw new Error("owner should get the editor variant");
await ownerP1.add({ text: "buy milk" }, context);
await ownerP1.add({ text: "call bob" }, context);
await until(() => guestP1.list.value.items.length, (n) => n === 2, "the guest to see two notes");
// The reader variant has no `add`: force the call through the editor's type to see what the worker answers.
let guestAdd: unknown = "accepted";
try {
	await (guestP1 as unknown as Editor).add({ text: "from the guest" }, context);
} catch (error) {
	guestAdd = isChordError(error) ? { code: error.code, reason: error.reason ?? null } : String(error);
}
result["1. owner and guest hold Notes { p1 }"] = {
	ownerVariant: ownerP1.variant,
	guestVariant: guestP1.variant,
	guestAdd,
	sameWorker: ownerP1.worker.value.pid === guestP1.worker.value.pid,
	// Calls never overlap; commits made meanwhile arrive folded, so only the newest value is stable.
	guestWatchLatest: guestSeen.at(-1) ?? null,
};

// 2. One process per project: p2 starts a second worker with its own store.
const ownerP2 = await owner.get(Notes, { project: "p2" }, context);
await (ownerP2 as Editor).add({ text: "p2 only" }, context);
await until(() => ownerP2.list.value.items.length, (n) => n === 1, "p2's note");
result["2. owner holds Notes { p2 }"] = {
	p2Items: ownerP2.list.value.items,
	p1Items: ownerP1.list.value.items,
	differentProcess: ownerP2.worker.value.pid !== ownerP1.worker.value.pid,
	forks: forks.map((each) => each.project),
};

// 3. Authorization at the route: the guest's grant is for p1 only.
let refused: unknown;
try {
	await guest.get(Notes, { project: "p2" }, context, { readyTimeout: 2_000 });
} catch (error) {
	refused = isChordError(error) ? { code: error.code, reason: error.reason ?? null } : String(error);
}
result["3. guest asks for Notes { p2 }"] = { refused };

// 4. Crash: kill worker p1. The owner's reference keeps its last values, the route forks p1 again, and the notes
//    come back from p1's store.
const states: RefState["kind"][] = [ownerP1.state.value.kind];
const stateWatch = await ownerP1.state.watch(context);
stateWatch.start(async (call) => {
	if (call.kind === "value" && states.at(-1) !== call.value.kind) states.push(call.value.kind);
});
const pidBefore = ownerP1.worker.value.pid;
children.get("p1")?.kill("SIGKILL");
await until(() => ownerP1.worker.value.pid, (pid) => pid !== pidBefore, "a new worker p1", 30_000);
await until(() => ownerP1.state.value.kind, (kind) => kind === "live", "the owner's reference to be live again");
await ownerP1.add({ text: "after the crash" }, context);
await until(() => guestP1.list.value.items.length, (n) => n === 3, "the guest to see the third note");
result["4. worker p1 killed"] = {
	ownerReferenceStates: states,
	newProcess: ownerP1.worker.value.pid !== pidBefore,
	itemsAfterRestart: ownerP1.list.value.items,
	guestFollowedToo: guestP1.list.value.items,
	guestWatchLatest: guestSeen.at(-1) ?? null,
	forks: forks.map((each) => each.project),
};
stateWatch.stop();
guestWatch.stop();

result.hostErrors = errors;
await owner.close(context);
await guest.close(context);
await server.close(context);
for (const child of children.values()) child.kill();
await emit(result);
