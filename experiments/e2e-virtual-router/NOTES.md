# Virtual models: plan on a strong model, implement on a cheap one

**Question.** pi 1.0 lets an extension register a *virtual model*: the user selects one model, and a router picks a physical model for every request. How is that recorded, and what does switching cost?

**What the experiment does.** [`fixtures/deepseek-router.ts`](../../fixtures/deepseek-router.ts) registers `router/auto`, adapted from pi's [`jev-router.ts`](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/examples/extensions/jev-router.ts): Jev rates the first message; complex work plans on `deepseek-v4-pro`, everything else uses `deepseek-flash`; after the first successful `edit`/`write`, the session switches to flash once. pi runs a complex coding task (LRU cache with TTL plus tests) and a simple question in parallel; the experiment reads both session files.

## Findings (2026-10-03, complex task)

```
selected router/auto
router state {"phase":"planning","model":"deepseek-v4-pro","complex":0.92}
dispatched deepseek/deepseek-v4-pro thinking=high tools=[bash]   cacheRead=0
dispatched deepseek/deepseek-v4-pro thinking=high tools=[write]  cacheRead=13184
router state {"phase":"implementation","model":"deepseek-flash","complex":0.92}
dispatched deepseek/deepseek-flash  thinking=low  tools=[write]  input=14154 cacheRead=512
dispatched deepseek/deepseek-flash  thinking=low  tools=[bash]   cacheRead=16512
dispatched deepseek/deepseek-flash  thinking=low  tools=[]       cacheRead=16768
```

The tests it wrote pass. The simple question was rated `complex: 0` and stayed on flash for its single request.

- **Selection and dispatch are stored separately.** `model_change` records `router/auto`; each assistant message records the physical model that answered. Providers only ever see physical models, so resuming or replaying across models works like a manual model switch.
- **Router state is a session entry.** `pi.virtual-model-state` follows the session tree (forks, `/tree`) and survives compaction.
- **One cache miss per switch.** The first flash request re-sends about 14k tokens uncached; the next ones hit again. The official example accepts exactly one miss per session for this reason. Returning `request.previous` for `continuation` requests keeps the cache.
- **Thinking levels are clamped.** The router passed `low`; v4-pro only supports `high` and `max`, so pi clamped it to `high`.

Source (v1.0.0): [`docs/virtual-models.md`](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/virtual-models.md), [`core/virtual-models.ts`](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/src/core/virtual-models.ts).

Rerun: `npm run exp -- e2e-virtual-router` (about 2 minutes, a few cents).
