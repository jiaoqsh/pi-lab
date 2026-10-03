# Do models follow a mid-conversation instruction?

**Question.** Keeping the cache is only useful if the model obeys an instruction that arrives as a system message in the middle of the conversation. Does it, and does collapsing change that?

**What the experiment does.** After one English exchange, a system message says: "From now on, answer only in Chinese, and end every answer with the word DONE." Three follow-up questions per model, with the message sent in place and collapsed. A trial passes if the answer contains Chinese and ends with `DONE`.

## Findings

| Model | In place | Collapsed |
|---|---|---|
| deepseek-flash | 3/3 (2026-10-02), 3/3 (2026-10-03) | 3/3, 3/3 |
| deepseek-v4-pro | 2/3, 2/3 | 2/3, 1/3 |

The sample is small. No difference between in place and collapsed shows up. flash follows in-place system messages even though the catalog does not enable them for it, so the flag does not seem to be about adherence; the reason is not documented.

Rerun: `npm run exp -- midconvo-adherence`; results land in `last-run.json`.
