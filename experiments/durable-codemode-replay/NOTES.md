# pi-durable: crash inside a codemode script

**Question.** pi-durable 1.2.0 ships a `codemode` tool (`@earendil-works/pi-durable/codemode`) declared `replay: "safe"`. Its argument is an arbitrary script that calls other tools and reads `Date.now()` and `Math.random()`. What makes rerunning such a script after a crash safe, and what does the outside world see?

**What the experiment does.** The faux model issues one `codemode` call with this script:

```js
const clock = Date.now();
const random = Math.random();
const results = [];
for (const n of [1, 2, 3]) {
  try {
    results.push(await tools.step({ n, clock, random }));
  } catch (error) {
    results.push("step " + n + " failed: " + error.message);
  }
}
return { clock, random, results };
```

Each `step` call appends a line to `side-effects.log` (the outside world) with the clock and random number the script passed. A child process exits with `process.exit(1)` inside step 2, after its side effect. A second process reopens the same SQLite storage; the faux model only scripts the final answer for it, so the codemode call is recovered from storage. Two scenarios differ only in the `step` tool's own `replay` policy. The snapshot replaces the clock and random values, which change every run, with placeholders.

## Findings (pi 1.2.0)

| `step` replay | step 1 | step 2 | step 3 | script result |
|---|---|---|---|---|
| `safe` | ran once (crash process) | ran twice (crash, then resume) | ran once (resume) | all three `done` |
| unset (`unsafe`) | ran once | ran once; the script gets `Tool step was interrupted and may have partially run` | ran once | step 2 caught as failed, steps 1 and 3 `done` |

In both scenarios:

- the script was **replayed, not rerun from scratch**: step 1's side effect happened once, and its result came back from storage;
- the replay saw **the same clock and random number** as the crashed process (`sameClockAndRandomInBothProcesses`); otherwise step 2 would have been called with other arguments and the call would have ended as diverged;
- there are three nested `pi.tool` tasks, one per step: the rerun reattached to the ones the crashed process created instead of creating new ones.

## How it works

Problem: rerunning a script is only safe if it makes the same calls with the same arguments, and only cheap if finished calls are not executed again. A script that reads the clock or randomness, or branches on results, cannot promise either by itself.

Three pieces make it safe:

1. **Deterministic VM.** pi-codemode 1.2.0's `sandbox.start()` runs the script with a virtual clock from `startedAt`, randomness from a stored `seed`, UTC, and no `WeakRef`/`FinalizationRegistry`, and reports a fingerprint of the VM. The same script fed the same results in the same order makes the same calls.
2. **Journal before delivery.** Each tool result is written to `pi.codemode.journal` (with the clock value and how many calls the script issued after processing it) before the script receives it. `pi.codemode.run` stores the start data (seed, deadline, fingerprint, module version) and, once, the outcome.
3. **Nested calls by key.** Each `tools.x()` is a nested call (`api.executeTool()`), its own `pi.tool` task owned by the codemode call, keyed `c<id>` by the VM's call number. A rerun that makes the same call gets the existing task: its stored result if finished, or its own recovery if not.

The rerun replays the journal into a fresh VM, checks every recorded count and key against what the replay does, and then goes live. Step 2's task was in its `execute` phase when the process died, so it followed **its own** replay policy: rerun when `safe`, an `interrupted` error result otherwise, which the script sees as a rejected promise. This is the [durable-crash](../durable-crash/NOTES.md) rule, applied one level down.

What it does not do: exactly-once execution. Step 2 ran twice in the safe scenario, because the crash came after its side effect and before its result was stored. A replay-safe tool with external effects still needs its own idempotency (an `api.memo` per step, as in durable-crash, or an idempotency key).

Divergence (another call count, another tool or arguments for a key, the script ending where it went on before), a changed module version or fingerprint, or a passed deadline end the call with an error result instead of replaying. pi's own tests cover those cases (`packages/durable/test/codemode.test.ts`); this experiment covers the path that works, across a real process exit.

Source (v1.2.0): [`docs/spec.md`](https://github.com/earendil-works/pi/blob/v1.2.0/packages/durable/docs/spec.md) sections 7.3 (nested calls) and 7.6 (code mode), [`src/codemode/codemode.ts`](https://github.com/earendil-works/pi/blob/v1.2.0/packages/durable/src/codemode/codemode.ts), pi-codemode [`CHANGELOG.md`](https://github.com/earendil-works/pi/blob/v1.2.0/packages/codemode/CHANGELOG.md) (`sandbox.start()`).

## Watch on upgrades

- `runsPerStep` changing means the replay or the nested-call reattachment changed.
- `sameClockAndRandomInBothProcesses: false`, or an error result instead of `Script completed`, means the replay diverged.
- The interrupted message is the same text the model gets for an interrupted model-issued call; a change shows here first.
