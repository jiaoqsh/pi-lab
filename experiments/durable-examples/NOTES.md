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

## 23-subagent-background: subagents on SQLite

Subagents are conversations owned by a task. They can be spawned, steered, stopped, and listed, report their answers back, and survive a restart, all on `openNodeSqliteStorage`.

## 25-compaction: unlimited conversation length

The model's context shrinks (for example 6 messages, then 4 after a summary) while stored entries only grow (9, 12, 15, 18): nothing is deleted. Three triggers appear: background compaction near the threshold, manual `compact()`, and compaction after a context-overflow error followed by one retry.

## Not included

`21-late-join` (a client attaching mid-run gets a snapshot, then only deltas) is deterministic locally but depends on streaming chunk timing, so it is left out of the snapshot to avoid flaky tracking. Run it from the pi repo:

```bash
node --conditions=source --experimental-strip-types packages/durable/test/examples/21-late-join.ts
```

Source (v1.0.0): [`packages/durable/test/examples`](https://github.com/earendil-works/pi/tree/v1.0.0/packages/durable/test/examples), [`README.md`](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md) sections "Busy Conversations" and "Compaction".
