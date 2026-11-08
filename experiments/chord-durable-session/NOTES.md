# Durable inside Chord v2: a worker per session, the Harness on the worker's store

**Question.** pi-durable (layer 4) keeps an agent's work across crashes; Chord v2 (layer 5) places objects in processes and lets clients reach them. Earendil's own app p3 combines the two: a worker process per session, a Chord object in it that opens Durable's Harness on the worker's store, clients that see the conversation through Chord references. What does the smallest app of that shape look like with the published 1.5.0 packages, and what happens when the worker dies in the middle of a tool call?

**What the experiment does.** It builds on [chord-server-worker](../chord-server-worker/NOTES.md) (server, route, fork, IPC link):

| File | Role |
|---|---|
| `core.ts` | Host kinds `Server` and `SessionHost({ id })`, principals (`owner`, `viewer` of one session), the `Chat` contract (`remote`, variants `owner` with `send` and `viewer` without), the `Agent` harness object (`local`, empty params), the Chord table `deploy.audit` |
| `worker.ts` | A session's process. `Agent` opens the Harness with `self.open` on `StoreStorage.open(store, Agent.name)`, follows the root conversation with `self.follow(observeConversation)` and derives a transcript. A `deploy` tool (`replay: "safe"`, a memo per step) writes each step to a log (the outside world), to the Chord table and to Durable's memo. The faux model calls `deploy`, then answers `Deployed api.` once the tool result is in its context |
| `run.ts` | The server and its route, an owner and a viewer client, the scenario, then a reopen of `s1.sqlite` |

```
owner  ─┐                                  ┌─▶ worker s1 (pid A, later pid B), one s1.sqlite:
        ├─ memory links ─▶ server ─ route ─┤      Agent ─ self.open ─▶ Harness (StoreStorage, owner "session.agent")
viewer ─┘                                  │      Agent ─ self.follow ─▶ conversation view ─▶ Chat.transcript
                                           │      deploy.audit (Chord table, same store)
```

The run holds step 3 back (a gate file) until it has killed the first worker, so the crash always lands between steps 2 and 3.

## Findings (chord 1.5.0, pi-durable 1.5.0)

| Scenario | Result |
|---|---|
| owner and viewer `get(Chat, { session: "s1" })` | one worker; `owner` and `viewer` variants; the viewer's forced `send` is refused `invalid/member` |
| owner sends "Deploy api"; worker SIGKILLed after step 2 | the log has steps 1 and 2 from worker#1; the viewer's transcript already shows the user entry and the tool call |
| after the kill | both references go `live → loading → live`; the route forks worker#2; the Harness resumes the tool task: `step 1: skipped (memo)`, `step 2: skipped (memo)`, `step 3: done`; the model answers; each step ran once across two processes |
| `s1.sqlite` reopened after shutdown | Durable's tables (`conversations`, `entries`, `tasks`, ...) and Chord's `deploy.audit` side by side under the owner `session.agent`, in one archive; audit rows 1 and 2 from worker#1, 3 from worker#2 |
| host errors | none |

**Without `harness.resume()` the session stalls.** In the first version, the second worker opened the Harness and the route, the references and the view all recovered, but the tool task never ran again: the transcript stopped at the tool call. Work a crash left "stays pending" until `resume()` starts the scheduler, or until a submit or a wait starts it ([README, Persist and Resume](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/README.md#persist-and-resume)). A CLI that resubmits with the same `requestId` (as [durable-crash](../durable-crash/NOTES.md) does) never notices this. A worker that a route reopens because a client holds a reference has nobody who submits, so its harness object must call `resume()` itself.

## How it works

- **Layer 5 decides where the agent runs and who reaches it.** `Chat { session }` resolves to `SessionHost({ id })`; the server authorizes, then forks the worker for it. The link stamps the principal, and the `Chat` factory picks the variant from it. Neither client names a process.
- **Layer 4 decides what survives.** Before `execute()` runs, the tool task commits its intent with `replay: "safe"`. Each finished step is a memo, so a rerun skips it. The tool author makes the promise; Durable stores it.
- **They meet in three calls, all in the `Agent` factory:**
  1. `self.open(() => Harness.open(await StoreStorage.open(store, Agent.name), ...))`: the Harness is a native of a persistent Chord object. It opens when the object activates and closes when the object ends.
  2. `StoreStorage` stores Durable's records as tables and documents of the worker's store under the object's type name. They share the store's commit queue, seq and id allocator with Chord's own tables. One file holds the whole session, and one export carries it.
  3. `self.follow((observer, ctx) => harness.value.observeConversation(...))`: Durable's synchronous observer becomes a Chord source. Each committed change of the view is one Chord change; a `derive` projects it, and remote references receive it as diffs.
- **A crash is a dropped link on one side and a reopen on the other.** The route resolves the held address again. The new `Agent` reopens the Harness on the same file and resumes. The references rebind to the new process's `Chat` with their last values kept meanwhile.

## Limits of this experiment

- The audit row and the memo are two commits of the same store, not one. A crash between them reruns the step's side effect, and the audit `put` (keyed by step) then overwrites the row. Idempotence still comes from the tool, as in durable-crash.
- The tools are fixed. p3 feeds the Harness its extensions from a Chord registry (`registryReader`, `HarnessRegistry`, design §24 and slice 8 §5), so a plugin reload can change them. That is still the reload experiment.
- No pi-env (tools on a remote machine), and no `createWorkers`, which 1.5.0 does not export (see chord-server-worker).

Sources (v1.5.0): Chord [`docs/next/slice-8.md`](https://github.com/earendil-works/pi/blob/v1.5.0/packages/chord/docs/next/slice-8.md) §5 ("Durable on registries", p3's pattern), [`docs/next/slices.md`](https://github.com/earendil-works/pi/blob/v1.5.0/packages/chord/docs/next/slices.md) (slice 6b: `StoreStorage`, `self.follow`); Durable [`test/examples/35-durable-on-the-store.ts`](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/test/examples/35-durable-on-the-store.ts), [`README.md`](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/README.md) (Persist and Resume, Tools).
