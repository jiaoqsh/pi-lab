# pi-durable: official examples as a regression baseline

**Question.** Do the behaviors the pi-durable README promises (busy inboxes, subagents that outlive their call, compaction) keep working across releases?

**What the experiment does.** It runs three examples copied from pi v1.0.0 (`examples/`, MIT, imports changed to the published packages) with the faux provider and records their printed output.

## 20-inbox: submissions while a conversation is busy

| `submit()` | Behavior |
|---|---|
| default (`followUp`) | queued; starts the next run when the current one answers |
| `whenBusy: "steer"` | queued; placed after the current tool round and joins the running work |
| `{ type: "write" }` | appends an entry without asking the model |
| `whenBusy: "reject"` | throws `ConversationBusy` |
| `submission.abort()` | withdraws a queued submission (`unanswered`, reason `aborted`) |

This is the "N clients can steer one conversation" part of pi-durable: every client submits to the same inbox document.

### Changed in 1.2.0: display-only writes no longer queue

| | 1.1.0 | 1.2.0 |
|---|---|---|
| inbox while busy | `10 followUp, 11 steer, 12 write` | `10 followUp, 11 steer` |
| transcript start | `pi.user, pi.assistant, app.note, ...` | `pi.user, app.note, pi.assistant, ...` |

The example's note is a write of only `kind` and `data`. 1.2.0 appends such a write at once, even while the conversation is busy, instead of holding it in `pi.inbox` until the next turn boundary ([#10407](https://github.com/earendil-works/pi/issues/10407), commit `e6b9a6af5`, `isDisplayOnly()` in `harness/inbox.ts`). It changes nothing the model sees, so a chat message shows as soon as it is sent. A queued reset still holds it back. Intended.

## 23-subagent-background: subagents on SQLite

Subagents are conversations owned by a task. They can be spawned, steered, stopped, and listed, report their answers back, and survive a restart, all on `openNodeSqliteStorage`.

### Changed in 1.2.0: every `subagent` tool result is empty

```diff
   subagent spawn reader "Summarize the plot of Moby Dick."
-  → Started reader.
-OK. Started reader.
+  → 
+OK. 
```

1.2.0 renamed `ToolExecutionResult.content` to `output` (breaking). The example's tool still returns `content`, which the Harness now ignores, so each result is the tool's streamed output, which is empty (`harness/tool.ts`: `result.output === undefined ? reported.output.snapshot() : ...`).

This is not only our copy: pi's own `test/examples/23-subagent-background.ts` was not updated either and returns `content` at v1.2.0 and on main as of 2026-10-12, so the official example prints the same empty results. TypeScript does not catch it: the `reply` helper's object also has an optional `details`, which overlaps `ToolExecutionResult`, so the weak-type check passes. A tool returning a literal `{ content }` with nothing else does fail to compile (pi-lab's analyst did).

The copy is kept as upstream has it, so the snapshot records the broken output; a diff back to `Started reader.` will show when upstream fixes the example.

## 25-compaction: unlimited conversation length

The model's context shrinks after each summary while stored entries only grow: nothing is deleted. Three triggers are meant to appear: background compaction near the threshold, manual `compact()`, and compaction after a context-overflow error followed by one retry.

### Changed in 1.0.2: the overflow retry no longer happens in this example

| Step | 1.0.0 | 1.0.2 |
|---|---|---|
| First threshold compaction | after the 4th question | after the 3rd question |
| "Summarize the plan" (the provider rejects it once as too long) | `answered`, after an **overflow** compaction and one retry | **`model_error`**, no retry |

Cause, verified: 1.0.2 (`70eceaade`, "persist provider session identities") gives every conversation a stable `sessionId` (a new `pi.provider` document, which also shifts the IDs in 20-inbox by one) and passes it to model requests. With a `sessionId`, pi-ai's **faux provider** simulates prompt caching, and its usage counts newly written prompt tokens twice, in both `input` and `cacheWrite`:

```
no sessionId : input=1002 cacheRead=0    cacheWrite=0    -> prompt counted as 1002
sessionId    : input=1002 cacheRead=0    cacheWrite=1002 -> prompt counted as 2004
sessionId    : input=105  cacheRead=1002 cacheWrite=106  -> prompt counted as 1213 (real: 1107)
```

Durable decides when to compact from that usage, so it compacts too early, and the run ends in `model_error` instead of an overflow compaction and retry (why the retry is skipped was not traced). Patching only that accounting in a copy of pi-ai 1.0.2 (`input = promptTokens - cacheRead - cacheWrite`) makes the example's output identical to 1.0.0, line for line. Real providers are not affected; the faux provider is what pi's own tests and examples run on.

Still the case in 1.1.0 and 1.2.0 (output unchanged).

## Not included

`21-late-join` (a client attaching mid-run gets a snapshot, then only deltas) is deterministic locally but depends on streaming chunk timing, so it is left out of the snapshot to avoid flaky tracking. Run it from the pi repo:

```bash
node --conditions=source --experimental-strip-types packages/durable/test/examples/21-late-join.ts
```

Source (v1.0.0): [`packages/durable/test/examples`](https://github.com/earendil-works/pi/tree/v1.0.0/packages/durable/test/examples), [`README.md`](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md) sections "Busy Conversations" and "Compaction".
