# Prompt-cache hits for mid-conversation changes (DeepSeek, measured)

**Question.** [midconvo-requests](../midconvo-requests/NOTES.md) shows the request shapes. Does sending a change in place really keep the provider's cache, and what does collapsing cost?

**What the experiment does.** For each strategy, a random nonce leads the system prompt so strategies never share cache. A warm-up request (about 2.1k system + 2.1k user tokens) writes the cache; after 3 seconds a follow-up with the change reports `prompt_cache_hit_tokens` (pi-ai maps it to `usage.cacheRead`). Model: `deepseek-flash`, with compat flags overridden per strategy. Cost: under $0.01.

## Findings (2026-10-03)

| Strategy | Follow-up prompt | Cache hit | Hit % |
|---|---|---|---|
| no change (baseline) | 4,250 | 4,096 | 96 |
| prompt change **in place** | 4,260 | 4,096 | 96 |
| prompt change **collapsed** into the leading system message | 4,261 | 1,792 | 42 |
| tool added (tool list resent) | 4,305 | 2,048 | 48 |

- In place costs nothing: the change comes after the cached prefix.
- Collapsing appends the change to the system text, so everything after it (the whole 2k-token conversation) is re-billed.
- Adding a tool breaks the cache after the system prompt, so DeepSeek renders tool definitions between the system prompt and the messages. That is why pi uses `tool_addition` (Anthropic) and `additional_tools` or synthesized tool-search items (OpenAI): they leave the tool list untouched.
- Hits come in multiples of 256 tokens here (1,792 = 7 × 256). Observed, not documented.

## A catalog detail

`deepseek-flash` does not set `supportsMidConvoSystemMessages` in pi-ai's catalog (only `deepseek-v4-pro` does), so by default pi collapses for flash, the 42% row. The API accepted in-place system messages for flash in this test, and [midconvo-adherence](../midconvo-adherence/NOTES.md) shows flash follows them. The flag's comment says the catalog enables it "for verified models".

Rerun: `npm run exp -- cache-deepseek`; results land in `last-run.json`.
