# pi-durable conformance suites

**Question.** pi-durable is growing toward hosts that pick their own pieces: where tools run (`ExecutionEnv`: the local machine, or another machine through the `pi-env` daemon that 1.0.4 introduced) and where state lives (`Storage`: memory, JSONL, SQLite, and on main a Cloudflare Durable Object adapter). pi ships conformance suites that define what each implementation must do. Do all the shipped implementations pass them, and how do the suites grow?

**What the experiment does.** It runs `createEnvConformance` and `createStorageConformance` from `@earendil-works/pi-durable/testing` with plain `node:assert` assertions against:

- `NodeExecutionEnv` (local), and `RemoteExecutionEnv` from `@earendil-works/pi-env` talking to the daemon binary the package ships, started on this machine over a pipe instead of over SSH (`lib/pi-env.ts`);
- `MemoryStorage`, the JSONL storage, and the SQLite storage (`node:sqlite`).

Each case gets a fresh temporary directory. `snapshot.json` lists the case names of both suites and, per implementation, how many passed and which failed with what message.

## Findings (pi 1.0.4)

| Implementation | Result |
|---|---|
| NodeExecutionEnv | 24/24 |
| RemoteExecutionEnv (pi-env daemon) | 24/24 |
| MemoryStorage | 23/23 |
| JSONL storage | 23/23 |
| SQLite storage | 23/23 |

The env suite covers the interfaces added in 1.0.3 rather than basic file I/O: bounded binary reads, paged directory listings, `watch()`, argv `exec`, and windowed output. 1.0.4 added three `watch()` cases (symlinked files, overlapping recursive targets, a directory replaced at the same path). The storage suite covers atomic commits, cursors and pagination, fork history, tasks, submissions, and document history.

## Changed in 1.1.0

The storage suite grew from 23 to 24 cases with `scans tables in either ID order and continues a cursor in its order`; all three storages pass 24/24, the env suite is unchanged. It comes with the new `order` field on conversation, entry, task, and submission scans, a breaking change for `Storage` implementations ([#10546](https://github.com/earendil-works/pi/issues/10546), commit `4dd2af42c`):

> `Storage` implementations must honor the new `order` field of `ConversationQuery`, `EntryQuery`, `TaskQuery`, and `SubmissionQuery`, and continue a cursor in the order it was returned with.

The case checks that a cursor carries its order (the next query may omit it) and that reusing a cursor in the other order throws. Drafted by the [release analyst](../../analyst/README.md) on the tracking PR; quotes checked against the source.

## Watch on upgrades

- New case names in `suites` show what pi now requires of every environment or storage.
- A failing case on one implementation is a regression of that implementation, or a suite change it has not caught up with.
- The Cloudflare Durable Object storage (`openDurableObjectSqliteStorage`, released in 1.1.0) cannot run here, since it needs a Durable Object, so it is not covered.

Source (v1.0.4): [`packages/durable/src/testing`](https://github.com/earendil-works/pi/tree/v1.0.4/packages/durable/src/testing), [`packages/env/README.md`](https://github.com/earendil-works/pi/blob/v1.0.4/packages/env/README.md).
