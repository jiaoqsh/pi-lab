// Base code shared by the server, the workers and the clients: host kinds, the principal type, the contracts.
import { arr, defineState, hostKind, int, local, method, obj, remote, str } from "@earendil-works/chord";

/** Who is calling. Links stamp it; a caller's own data never sets it. */
export type P =
	| { readonly kind: "server" }
	| { readonly kind: "worker"; readonly project: string }
	| { readonly kind: "owner" }
	| { readonly kind: "guest"; readonly project: string };

export const Server = hostKind("server");
export const Project = hostKind("project", { id: str() });

const NoteList = obj({ items: arr(str()) });
const WorkerInfo = obj({ pid: int() });

/** The public contract: one Notes object per project, served by that project's worker. */
export const Notes = remote("notes", {
	version: 1,
	params: { project: str() },
	hostAddress: ({ project }) => Project({ id: project }),
	variants: {
		editor: { state: { list: NoteList, worker: WorkerInfo }, methods: { add: method(obj({ text: str() })) } },
		reader: { state: { list: NoteList, worker: WorkerInfo } },
	},
});

/** The worker's own store object: local with empty params, so it lives as long as the host and may persist. */
export const NoteStore = local("notes.store", {
	version: 1,
	params: {},
	members: { list: NoteList, add: method(obj({ text: str() })) },
});

export const NotesDoc = defineState("notes", {
	schema: NoteList,
	version: 1,
	initial: () => ({ items: [] }),
	persist: true,
	checkpointWhen: () => true,
});
