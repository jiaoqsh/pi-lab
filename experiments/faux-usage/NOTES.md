# Faux provider usage with a sessionId

**Question.** [durable-examples](../durable-examples/NOTES.md) changed in pi 1.0.2: compaction started a turn early and the overflow retry ended in `model_error`. The cause traced back to the usage pi-ai's faux provider reports. What exactly does it report?

**What the experiment does.** Two requests to the faux provider, the second extending the first, once without and once with a `sessionId`. With a `sessionId` the faux provider simulates prompt caching. `promptCounted` is `input + cacheRead + cacheWrite`, the prompt size a consumer derives from usage.

## Findings (pi-ai 1.0.4)

| Request | without sessionId | with sessionId |
|---|---|---|
| first (1002-token prompt) | input 1002, prompt counted **1002** | input 1002, cacheWrite 1002, prompt counted **2004** |
| second (1107-token prompt) | input 1107, prompt counted **1107** | input 105, cacheRead 1002, cacheWrite 106, prompt counted **1213** |

With a `sessionId`, tokens written to the simulated cache are counted in both `input` and `cacheWrite`. Providers such as Anthropic report them in one field only: `input` excludes cache reads and writes. The fix is `input = promptTokens - cacheRead - cacheWrite` in `withUsageEstimate` ([`providers/faux.ts`](https://github.com/earendil-works/pi/blob/v1.0.4/packages/ai/src/providers/faux.ts)); with it, the 25-compaction example prints exactly its 1.0.0 output again.

Why it surfaced in 1.0.2: pi-durable started passing a stable `sessionId` to model requests (`70eceaade`, "persist provider session identities"). The faux code is older; nothing passed a `sessionId` to it in durable before.

## Watch on upgrades

A fix changes the `with sessionId` rows of `snapshot.json` (expected: prompt counted 1002 and 1107), and the 25-compaction output in durable-examples should return to its 1.0.0 form.
