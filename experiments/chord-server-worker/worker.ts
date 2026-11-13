// A project's worker process, forked by the server's route: run as `worker.ts <project> <dir>`.
// It serves Notes for its project, keeps the notes in its own store (<dir>/<project>.sqlite), and connects to the
// server over the IPC channel it was forked with.
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { constant, createHost, defineFacet, ipcLink, openStore, sqliteBackend } from "@earendil-works/chord";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { NoteStore, Notes, NotesDoc, type P, Project } from "./core.ts";

const [project, directory] = process.argv.slice(2);
if (project === undefined || directory === undefined || process.send === undefined) {
	throw new Error("usage: worker.ts <project> <dir>, forked with an IPC channel");
}
const context = BACKGROUND_CONTEXT;

// Make the link first: it queues the server's messages until the host listens.
const link = ipcLink(process as Parameters<typeof ipcLink>[0]);

const facet = defineFacet<P>((host) => {
	// The persisted data, once per worker.
	host.serve(NoteStore, (_params, self) => {
		const doc = self.state(NotesDoc);
		return {
			list: doc,
			add: async ({ text }, ctx) => {
				await self.tx(async (tx) => {
					(await tx.draft(doc)).items.push(text);
				}, ctx);
				return null;
			},
		};
	});
	// One view per (project, principal): the variant decides what the caller may do.
	host.serve(Notes, (_params, principal, self) => {
		const store = self.get(NoteStore, {});
		const worker = constant({ pid: process.pid });
		if (principal.kind === "owner") {
			return { variant: "editor", members: { list: store.list, worker, add: (args, ctx) => store.add(args, ctx) } };
		}
		return { variant: "reader", members: { list: store.list, worker } };
	});
});

const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(join(directory, `${project}.sqlite`))), context);
const host = createHost<P>({
	address: Project({ id: project }),
	principal: { kind: "worker", project },
	store,
	onError: (error) => console.error(`[worker ${project}]`, error.kind),
});
host.connect(link, { principal: { kind: "server" }, trusted: true }, context);
await host.load([{ name: "@lab/notes", facet }], context);

process.on("disconnect", () => {
	void host
		.close(context)
		.then(() => store.close(context))
		.finally(() => process.exit(0));
});
