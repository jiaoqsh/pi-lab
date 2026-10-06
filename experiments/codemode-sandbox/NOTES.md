# Codemode sandbox

**Question.** pi's `codemode` tool lets the model write a JavaScript script that calls other tools. What is the sandbox, how does a call cross from the script to the host, and how do scripts fail?

**What the experiment does.** It drives `CodemodeSandbox` from `@earendil-works/pi-codemode` directly with fake tools (one returns 5000 issues after 1 s) and records how each scenario ends. No model is involved.

## Findings (pi 1.0.0 to 1.0.4)

| Scenario | Result | Why |
|---|---|---|
| Two 1 s calls in `Promise.all` | Done in about one call's time; 10,000 rows filtered to a 2-line summary | Calls are promises the host runs concurrently; only the script's output reaches the model |
| `store()` then `load()` in a later execution | `storeWrites` returned, read back next time | The sandbox keeps no state; the host persists writes (pi appends a `codemode-store` session entry) |
| `tools.Notify` (typo) | `Did you mean tools.notify?` | `tools` is a `Proxy` that fuzzy-matches unknown members |
| Uncaught error after a successful call | Output before the error is kept; the call is not undone | Tool calls are real side effects |
| `typeof process`, `fetch`, `setTimeout` | all `undefined` | QuickJS compiled to wasm, no Node APIs |
| `await new Promise(() => {})` | Fails immediately, no timeout wait | With no timers and no pending call, nothing can ever settle it |
| `while (true) {}` | `kind: timeout` | Host sets a `SharedArrayBuffer` flag polled by the VM's interrupt handler, then terminates the worker |
| Allocate until it breaks | `InternalError: out of memory`, host unaffected | `memoryLimitBytes` (pi uses 256 MB) |
| `JSON.stringify(tools.x())` without `await` | **`"{}"`, no error** | A promise serializes to `{}` |
| `const tools = 1` | `SyntaxError: invalid redefinition of parameter name` | The script is the body of `async (tools, console) => {…}` |
| `Array.prototype.toJSON = …` | 1.0.4: ignored, `JSON.stringify([1, 2])` is `"[1,2]"`. 1.0.2: the patch took effect (`"patched"`) | 1.0.4 freezes built-ins before the script runs; per pi's changelog such patches could crash the host and leave `execute()` unsettled ([#10444](https://github.com/earendil-works/pi/issues/10444)). The crash itself was not reproduced here |

## How it works

```
script: tools.x(args)
  -> prelude: new Promise, stored in `pending` by id; bridge("call", id, name, json)
  -> worker thread: postMessage({ type: "call" })          QuickJS VM lives here
  -> host: tool.execute()                                   main thread, the real tool
  -> postMessage({ type: "result", id }) -> settle(id) -> executePendingJobs() -> stalled() check
```

Every execution gets a fresh worker and VM; the compiled wasm module is shared by structured clone. Arguments and results cross as JSON strings.

Source (v1.0.0): [`runtime/worker.ts`](https://github.com/earendil-works/pi/blob/v1.0.0/packages/codemode/src/runtime/worker.ts), [`runtime/prelude-source.ts`](https://github.com/earendil-works/pi/blob/v1.0.0/packages/codemode/src/runtime/prelude-source.ts) (`caller`, `guard`, `stalled`), [`runtime/host.ts`](https://github.com/earendil-works/pi/blob/v1.0.0/packages/codemode/src/runtime/host.ts), and pi's wiring in [`extensions/codemode/execute.ts`](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/src/extensions/codemode/execute.ts).

## The missing-await gap

The last two rows matter in practice: in [e2e-mcp-discovery](../e2e-mcp-discovery/NOTES.md) every DeepSeek run that used codemode wrote `searchTools(...)` without `await` and got `{}`. pi 1.0's prompt shrink (commit `6f1072cc0`) removed "resolves to" and `await searchTools(query)` from the codemode tool description, so the description no longer says these helpers are async. A local patch that makes `Promise.prototype.toJSON` throw an "add await" hint fixed recovery in one turn; it was not upstreamed (low impact).

## Watch on upgrades

Added in pi 1.0.4: the `patch-builtin` scenario, after pi froze built-ins.


The `missing-await-stringify` and `declare-tools-variable` scenarios change if pi improves these errors. Any change to the error texts, the timeout mechanism, or the declaration rendering shows up in `snapshot.json`.
