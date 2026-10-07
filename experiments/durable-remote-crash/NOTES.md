# Remote tools: the daemon, the transport, or the harness dies mid-command

**Question.** pi 1.0.4 added `@earendil-works/pi-env`: pi-durable's tools run on another machine through a small daemon reached over SSH, while the harness, its storage, and credentials stay local. [durable-crash](../durable-crash/NOTES.md) showed what happens to a tool call when the harness dies. With a remote environment there are more places to fail. What does the model see in each case, and does the command on the remote side keep running?

**What the experiment does.** The coding tools (`CodingTools`) run through `RemoteExecutionEnv`, with the daemon binary the package ships started on this machine over a pipe, the way SSH would start it. A scripted model calls `bash` with `sleep 3 && echo finished > marker.txt`, then a second `bash` call. One second into the first command:

- **A** kills the daemon process (a crash or an OOM kill);
- **A2** kills a pipe proxy between the connection and the daemon ([`fixtures/pipe-proxy.ts`](../../fixtures/pipe-proxy.ts)), which cuts the transport while the daemon lives, as a dropped SSH connection would;
- **B** exits the harness process (JSONL storage), then reopens the storage in a new process.

`markerWritten` says whether the command finished on the "remote" side anyway.

## Findings (pi 1.0.4)

| Failure | Model sees | Command finished anyway? | Afterwards |
|---|---|---|---|
| A: daemon killed | `[error] pi-env connection lost` | **yes**: the shell outlives the daemon and writes the marker | the next call starts a new daemon and works |
| A2: transport cut | `[error] pi-env connection lost` | no: the daemon sees its stdin close, exits, and stops what it started | the next call starts a new daemon and works |
| B: harness dies | after restart: `Tool bash was interrupted and may have partially run` | no: the daemon's stdin closes with the harness | the run completes on restart |

- Reconnecting is automatic: `Connection` starts the daemon again on the next request.
- A transport loss (A2) or a harness crash (B) leaves nothing running: the daemon kills the commands it started when its stdin closes.
- **A and A2 give the model the same message, but in A the command keeps running and completes.** A model that retries after "connection lost" can run a non-idempotent command twice. pi-env's own docs say requests in flight when the connection is lost fail "with code `unknown`; for mutations their outcome is then unknown"; the tool result does not pass that on, unlike B's "may have partially run". A daemon crash is rarer than a dropped connection, so this is an edge case.

## Watch on upgrades

Changes to these messages (for example passing on "outcome unknown"), or to whether an orphaned command survives a daemon crash, show up in `snapshot.json`.

Source (v1.0.4): [`packages/env`](https://github.com/earendil-works/pi/tree/v1.0.4/packages/env) (`connection.ts`, `remote-env.ts`), [`docs/protocol.md`](https://github.com/earendil-works/pi/blob/v1.0.4/packages/env/docs/protocol.md).
