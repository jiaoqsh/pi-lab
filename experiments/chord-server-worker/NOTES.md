# Chord v2: one server, one worker process per project

**Question.** Chord v2 (`@earendil-works/chord`, `/next` until 1.5.0, experimental) is the object system pi's authors build their own app on: a server, a worker process per session, clients that reach workers through the server. What does the smallest app of that shape look like with the published 1.5.0 package, and what does Chord do for it?

**What the experiment does.** Three files, no plugins component:

| File | Role |
|---|---|
| `core.ts` | Base code shared by every process: host kinds `Server` and `Project({ id })`, the principal type, the `Notes` contract (`remote`, placed by `hostAddress: ({ project }) => Project({ id: project })`, variants `editor` and `reader`), the worker's `NoteStore` (`local`, empty params) and its persisted document |
| `worker.ts` | A project's process: a host with address `Project({ id })` and its own store (`<project>.sqlite`), connected to the server over the IPC channel it was forked with |
| `run.ts` | The server host with a route for `Project` (`authorize`, then `resolve` forks `worker.ts` and returns an `ipcLink`), two client hosts (owner, guest) on memory links, and the scenarios |

```
owner client ─┐                  ┌─▶ worker p1 (pid A, later pid C)   p1.sqlite
              ├─ memory links ─▶ server ── route Project ─┤
guest client ─┘   (principal      (authorize, resolve:    └─▶ worker p2 (pid B)           p2.sqlite
                   stamped here)   fork + ipcLink)
```

## Findings (chord 1.5.0)

| Scenario | Result |
|---|---|
| owner and guest `get(Notes, { project: "p1" })` | one worker forked; owner gets `editor`, guest `reader`; both views share one process and one `NoteStore` |
| guest calls `add` anyway (cast through the editor type) | refused by the worker: `invalid/member` |
| guest watches `list` while the owner adds | the guest's watch gets the worker's commits through the server's relay |
| owner `get(Notes, { project: "p2" })` | a second worker, a second store: p2 has only its own note |
| guest `get(Notes, { project: "p2" })` | refused at the server's route before anything starts: `forbidden` |
| worker p1 killed with `SIGKILL` | the owner's reference goes `live → loading → live`, keeping its last values; the route forks p1 again; the notes come back from `p1.sqlite`; the guest's reference follows too; no host error |

## How it works

- **Routing is the address.** The client computes `Project({ id: "p1" })` from the params and sends the hold to its parent. The server has a route for the kind, so it calls `authorize` with the principal the client's link stamped, then `resolve` once for an address that is held and has no link. Nothing in app code names a host or a process.
- **Who calls is the link's to say.** The server's `accept(link, { principal })` decides that a client is the owner or a guest; the hold carries that principal to the worker over the trusted IPC link, and the `Notes` factory picks the variant from it. A remote object's identity includes the principal key, so owner and guest hold two objects over one `NoteStore`. Design: "shared store, per-principal views".
- **Persisted data lives in a `local` object with empty params** (`NoteStore`): it lives as long as the worker and its document is a row of the worker's store. `Notes` objects hold no data of their own; `list` is the store's member, re-exposed.
- **A crash is a dropped link.** The route's link closes after a completed handshake, so the address resolves again while it is held. References do not end: they show `loading` with their last values and rebind to the new process's object with one diff. The client code has no retry logic.

## Changed in 1.5.1: v2 is the package root

The run failed at import with `ERR_PACKAGE_PATH_NOT_EXPORTED` for `@earendil-works/chord/next`: the `./next` key is gone from the package's `exports`. Chord 1.5.1 promoted v2 to the root (commit `7ac1a9e3a`):

> Chord v2 is the package's root: `@earendil-works/chord` exports v2 (was `@earendil-works/chord/next`). [...] Migration: imports of `@earendil-works/chord/next` drop `/next`

Dropping `/next` in `core.ts`, `worker.ts` and `run.ts` is the whole migration; every name the experiment imports is on the new root, and the snapshot is unchanged. The same release exports the workers component: `@earendil-works/chord/workers` (`createWorkers`) and `@earendil-works/chord/workers/child` (`workerMain`, `processLock`). The experiment still wires `host.route` and `fork` itself.

## What 1.5.0 does not offer yet

- The workers component (`createWorkers`, `workerMain`: start timeouts, idle stop, process locks, plugin scripts in the start message) is built (`dist/next-node/workers`) but not in the package's `exports`; the experiment wires `host.route` and `fork` itself, which is the low-level API the component is built on.
- No plugins component and no reload here: facets are imported directly. Reload is the next experiment.

Sources (v1.5.0): [`docs/next/design.md`](https://github.com/earendil-works/pi/blob/v1.5.0/packages/chord/docs/next/design.md) sections 3 (hosts, routes), 4 (principals), 5 (variants), 6 (shared store, per-principal views), 7 (references); [`docs/next/guide-plugins-hosts/book.md`](https://github.com/earendil-works/pi/blob/v1.5.0/packages/chord/docs/next/guide-plugins-hosts/book.md).
