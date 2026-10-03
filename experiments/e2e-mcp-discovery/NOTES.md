# MCP tools the model cannot see: codemode vs tool_search

**Question.** By default pi does not declare MCP tools to the model. With `codemode` exposure (default) the model must find them from a script (`searchTools()`, `ALL_TOOLS`); with `deferred` exposure it loads them with `tool_search`. How do real models get there, and what does it cost?

**What the experiment does.** It runs the published `pi` CLI in an isolated config directory with [`fixtures/shop-mcp-server.ts`](../../fixtures/shop-mcp-server.ts), a dependency-free stdio MCP server (`list_orders` returns 3000 orders, `get_customer`). Seven runs in parallel: a lookup ("tier of customer C16") with each exposure on `deepseek-flash` and `deepseek-v4-pro`, plus a refund analysis over all orders.

## Findings (pi 1.0.0, 2026-10-03)

| Run | Turns | `{}` results | `const tools` errors | Correct | Cost |
|---|---|---|---|---|---|
| lookup, codemode, flash #1 / #2 | 5 / 4 | 1 / 1 | 1 / 0 | yes | $0.0017 / $0.0015 |
| lookup, codemode, v4-pro #1 / #2 | 6 / 5 | 2 / 1 | 1 / 1 | yes | $0.0075 / $0.0068 |
| lookup, tool_search, flash | **3** | 0 | 0 | yes | $0.0010 |
| lookup, tool_search, v4-pro | **3** | 0 | 0 | yes | $0.0039 |
| refunds, codemode, v4-pro | 10 | 2 | 0 | yes | $0.0388 |

- **tool_search takes the shortest path**: search, call, answer. The session shows the mechanism: after `tool_search` a system message with `toolsAdded: [mcp__shop__get_customer, mcp__shop__list_orders]` is appended, the same delta as in [midconvo-requests](../midconvo-requests/NOTES.md), so the next request declares them while keeping the cache.
- **codemode runs lose turns to two script mistakes**: `searchTools(...)` without `await` (the promise prints as `{}` with no error, so the model concludes nothing was found) and `const tools = …` (a parameter name of the script function). See [codemode-sandbox](../codemode-sandbox/NOTES.md) for the cause: the 1.0 codemode description no longer says these helpers are async.
- **Filtering pays off once the model does it**: in the refund run the model first returned the raw `list_orders` result (about 146k tokens, truncated to 10k with a warning), then filtered inside the script and returned a few hundred characters. Answer: $152,100 over 600 refunded orders; C16 and C36 tie at $19,575.

## Operational note

`pi --mode json` started from a process whose stdin is an open pipe (common in automation) waits for stdin to end before doing anything, because piped stdin is prepended to the prompt. [`lib/pi-cli.ts`](../../lib/pi-cli.ts) spawns pi with stdin closed.

Rerun: `npm run exp -- e2e-mcp-discovery` (about 30 s, a few cents).
