# Jev: a classifier as a programming primitive

**Question.** pi 1.0 runs non-LLM models: classifiers such as TypeSafe's Jev (`models.classify()` in codemode, `ctx.modelRegistry.classify()` in extensions) and image models. What does a classifier call look like, and is it fast enough to sit in front of every session?

**What the experiment does.** It asks Jev two typed questions about three prompts: a `choice` (standard or complex) and a `bool` (does it ask to edit code). The [virtual router](../e2e-virtual-router/NOTES.md) makes the same `complexity` call before the first request of a session.

## Findings (2026-10-03)

| Prompt | complexity | P(edits code) | Latency |
|---|---|---|---|
| Fix a README typo | standard | 0.99 | 568 ms (first call) |
| Redesign session storage with copy-on-write forks | complex | 0.98 | 245 ms |
| What does `--print` do? | standard | 0.02 | 245 ms |

- Answers are typed: a `choice` returns `choice`, `probabilities`, and `confidence`; a `bool` returns `probability`; a `score` returns the expected level index.
- Reported cost was `0`.
- Calls never throw on provider errors: check `stopReason` and `errorMessage`.

Source (v1.0.0): [`docs/codemode.md`](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/codemode.md) ("Classify"), [`docs/models.md`](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/models.md).

Not covered: `models.generateImages()` (needs an image-model provider key such as OpenRouter).
