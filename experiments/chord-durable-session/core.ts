// Base code shared by the server, the session workers and the clients: host kinds, the principal type, the contracts.
import { arr, defineTable, hostKind, int, local, method, obj, remote, str } from "@earendil-works/chord/next";

/** Who is calling. Links stamp it; a caller's own data never sets it. */
export type P =
	| { readonly kind: "server" }
	| { readonly kind: "worker"; readonly session: string }
	| { readonly kind: "owner" }
	| { readonly kind: "viewer"; readonly session: string };

export const Server = hostKind("server");
export const SessionHost = hostKind("session", { id: str() });

/** A projection of Durable's conversation view: one line per transcript entry. */
export const Transcript = obj({ entries: arr(obj({ kind: str(), text: str() })) });
const WorkerInfo = obj({ pid: int() });

/** The public contract: one Chat object per session, served by that session's worker. */
export const Chat = remote("chat", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => SessionHost({ id: session }),
	variants: {
		owner: { state: { transcript: Transcript, worker: WorkerInfo }, methods: { send: method(obj({ text: str() })) } },
		viewer: { state: { transcript: Transcript, worker: WorkerInfo } },
	},
});

/**
 * The harness object: local with empty params, so it lives as long as the worker and may persist. It opens Durable's
 * Harness on the worker's store and follows the root conversation's view.
 */
export const Agent = local("session.agent", {
	version: 1,
	params: {},
	members: { transcript: Transcript, send: method(obj({ text: str() })) },
});

/** A Chord table in the same store as Durable's records: one row per finished deploy step. */
export const Audit = defineTable("deploy.audit", {
	version: 1,
	columns: { step: int(), pid: int() },
	key: ["step"],
});
