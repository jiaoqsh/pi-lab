# A/B: one word in the codemode description

**Question.** In [e2e-mcp-discovery](../e2e-mcp-discovery/NOTES.md), DeepSeek models often wrote `searchTools(...)` without `await`, serialized the promise, got `{}` with no error, and lost turns. Is that a model quirk, or caused by pi 1.0's codemode description?

**Background.** pi 1.0's prompt shrink (commit `6f1072cc0`) reduced the codemode globals to one line:

> `ALL_TOOLS`, `searchTools(query, { limit?, namespace? })`, `describeTool(name)`, `describeNamespace(name)`: find unlisted tools, such as MCP tools.

Before it, the description said each helper "resolves to" its result and told the model to "call `await searchTools(query)`". Now the synchronous `ALL_TOOLS` and three async helpers share a line with nothing marking which are async.

**What the experiment does.** It copies the published `pi-coding-agent` package, replaces that one sentence with a version that writes `await searchTools(…)`, `await describeTool(name)`, `await describeNamespace(name)`, and runs the same task through both: find the hidden shop MCP tool and look up a customer. 10 runs per model and variant. It checks the codemode description each model actually received, so the comparison is known to differ only in that sentence. If pi changes the sentence, the experiment fails instead of measuring nothing.

## Findings (pi 1.0.0, 2026-10-04)

The `1.0.0 description` rows are the published description (the variant is now labeled `published description`).

| Variant / model | Runs with a promise serialized as `{}` | `const tools` errors | Mean turns | Mean cost |
|---|---|---|---|---|
| 1.0.0 description / flash | **6/10** | 3/10 | 4.0 | $0.00124 |
| 1.0.0 description / v4-pro | **7/10** | 7/10 | 6.2 | $0.00641 |
| with `await` / flash | **0/10** | 3/10 | 3.4 | $0.00102 |
| with `await` / v4-pro | **0/10** | 6/10 | 4.5 | $0.00465 |

All 40 runs answered correctly; the difference is the path. 13 of 20 runs versus 0 of 20 (Fisher's exact test, p < 0.0001). Turns drop by 15% (flash) and 27% (v4-pro), and so does cost.

Rerun on **pi 1.0.2** (same day, the sentence is unchanged): 16/20 runs serialized a promise with the published description (8/10 on each model), 0/20 with `await`; mean turns 4.0 / 5.7 versus 3.6 / 4.6.

Rerun on **pi 1.0.4** (2026-10-07, sentence still unchanged): 13/20 (flash 8/10, v4-pro 5/10) versus 0/20; mean turns 4.4 / 5.8 versus 3.8 / 4.5. This is the baseline to compare with once the upstream fix ships.

Typical failing first scripts:

```js
const found = searchTools("customer", { limit: 30 });
return JSON.stringify(found, null, 2);        // "{}"
```

## Upstream fix

Reported as [#10555](https://github.com/earendil-works/pi/issues/10555) with the DeepSeek data above. A maintainer reopened it the same day and pi fixed it, released in 1.1.0, in [`269121616`](https://github.com/earendil-works/pi/commit/269121616c520a6a9aa9b5da29f1b233ccbed10c) ("mark codemode lookup helpers as async in description"), using the same sentence as the `with await` variant, plus a test that the description keeps the three `await`s. 
Once a release contains it, this experiment runs only the published description (labeled `published description (has await, #10555)`), which checks the fix on a real release: the expected result is 0 runs with `{}`.

**Verified on pi 1.1.0** (2026-10-08, the first release with the fix): 0/20 runs serialized a promise (0/10 on each model), against 13/20 with the 1.0.4 description. Mean turns 3.5 (flash) and 4.2 (v4-pro), against 4.4 and 5.8 on 1.0.4. The independent `const tools` problem remains (5/10 and 3/10).

## GPT-5.6-sol (pi 1.0.4, 2026-10-06)

Run through a third-party OpenAI-compatible relay with the Responses API, the API pi uses for OpenAI models (`AB_MODELS=openai-relay/gpt-5.6-sol`, see `run.ts`). Two batches of 10 runs per variant, recorded in [`gpt-5.6-sol.json`](gpt-5.6-sol.json).

| Variant | Runs with a promise serialized as `{}` | `const tools` errors | Mean turns | Mean prompt tokens |
|---|---|---|---|---|
| published description | **6/20** | 0/20 | 3.85 | 27,835 |
| with `await` | **0/20** | 0/20 | 3.50 | 26,587 |

Fisher's exact test: p = 0.02. GPT misses the `await` less often than DeepSeek (30% versus 65-80%), but the same way:

```js
const t = searchTools('shop customer lookup', {limit:10}); text(t);   // "{}"
```

GPT never named a variable `tools`, so the second problem below looks model-specific.

Caveat: the relay serves its own default instructions when a request has none. With pi's instructions present it echoed them unchanged, but hidden additions cannot be ruled out from the outside.

## A second, independent problem

`const tools = …` fails with `SyntaxError: invalid redefinition of parameter name` because scripts run as the body of `async (tools, console) => {…}`. It happens in about half of the runs with either description: `tools` is the obvious name for a list of search results. The `await` sentence does not affect it. Several such scripts also lacked `await`; the syntax error hides that, so the promise rate in the 1.0.0 rows is a lower bound.

## Limits

DeepSeek (flash, v4-pro) through DeepSeek's API and GPT-5.6-sol through a relay; Claude was not tested. The task is small and discovery-heavy, which is where these helpers are used.

Rerun: `npm run exp -- codemode-await-ab` (about a minute, about $0.15). `AB_RUNS=20` for more runs per cell.
