# pi-durable: crash in the middle of a tool call

**Question.** pi-durable promises that "every step of a run is a task that stores a checkpoint before it moves on". What actually happens when the process dies while a tool is running?

**What the experiment does.** A `deploy` tool runs three steps; each step appends a line to `side-effects.log` (the outside world). A child process exits with `process.exit(1)` right after step 2. A second process reopens the same JSONL storage. The faux model only scripts the final answer for the second process, which proves the tool call is recovered from storage, not requested again.

## Findings (pi-durable 1.0.0)

| Scenario | What the model sees after restart | Outside world |
|---|---|---|
| default (`replay` unset) | error: `Tool deploy was interrupted and may have partially run` | steps 1, 2 ran; 3 never ran |
| default, with 250 ms between steps | same error, preceded by `step 1: done`, `step 2: done` | same |
| `replay: "safe"` + `api.memo` per step | `step 1: skipped (memo)`, `step 2: skipped (memo)`, `step 3: done` | each step ran exactly once, across two processes |

## How it works

Before `execute()` runs, the tool task commits its intent as a checkpoint: `{ phase: "execute", arguments, replay }`. On recovery the task resumes in that phase:

- rerun only if both the stored policy and the current tool definition say `replay: "safe"`;
- otherwise settle with an `interrupted` error result and the output committed so far, and let the model decide.

`replay: "safe"` is a promise from the tool author, not a guarantee from pi. Idempotence comes from `api.memo(name, value)` (first write wins, stored durably) or from `requestId` on submissions, as the subagent example does.

**Partial output depends on timing.** `api.output()` is not synchronous. Progress commits are adaptive: the first change commits at once, later commits wait at least 100 ms and longer for large writes ([`harness/output.ts`](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/src/harness/output.ts), `Progress`). With no `await` between `output()` and the crash, not even the first commit completes, so the model gets no partial output. Durable state that must survive belongs in `memo` or `commit`, which await the storage write.

Storage format: each line of `main.jsonl` is one atomic commit (`seq`); task checkpoints are `task.sidecar` writes; documents such as `pi.live` live in `doc-N.jsonl`. The first commit of a run includes a `pi.system` entry with `toolsAdded`, the same `SystemMessage` delta model as pi-ai ([midconvo-requests](../midconvo-requests/NOTES.md)).

Source (v1.0.0): [`harness/tool.ts`](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/src/harness/tool.ts) (`ToolTask`, phases `call` and `execute`), [`README.md`](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md).

## Watch on upgrades

pi-durable is marked experimental ("the API changes without notice"). A failing run here is as informative as a changed snapshot.
