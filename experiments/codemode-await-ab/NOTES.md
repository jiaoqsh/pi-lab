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

Typical failing first scripts:

```js
const found = searchTools("customer", { limit: 30 });
return JSON.stringify(found, null, 2);        // "{}"
```

## A second, independent problem

`const tools = …` fails with `SyntaxError: invalid redefinition of parameter name` because scripts run as the body of `async (tools, console) => {…}`. It happens in about half of the runs with either description: `tools` is the obvious name for a list of search results. The `await` sentence does not affect it. Several such scripts also lacked `await`; the syntax error hides that, so the promise rate in the 1.0.0 rows is a lower bound.

## Limits

Only DeepSeek models were tested (the keys at hand). Stronger models may rarely miss the `await`. The task is small and discovery-heavy, which is where these helpers are used.

Rerun: `npm run exp -- codemode-await-ab` (about a minute, about $0.15). `AB_RUNS=20` for more runs per cell.
