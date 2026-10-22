# Mid-conversation system messages on the wire

**Question.** pi 1.0 changes the system prompt and the tool set in the middle of a session (tool_search loading a tool, a mode switch, an extension adding a section). Re-sending a different system prompt would invalidate the provider's prompt cache. How does each provider receive such a change?

**What the experiment does.** It builds one transcript with a second system message (replace section `mode`, add an instruction, add tool `deploy`) and captures the request body pi-ai would send to each provider via `onPayload`, aborting before anything is sent.

## The core idea: the prompt is part of the transcript

```ts
interface SystemMessage {
  role: "system";
  content: string;                          // extra instructions from this point on
  sections?: Record<string, string | null>; // replace or remove named prompt sections
  toolsAdded?: Tool[]; toolsRemoved?: ToolReference[];
}
```

The first system message is the system prompt. Later ones are deltas. Replaying them in order (`getCurrentSystemMessage`) yields the current prompt and tools. Each model declares in its compat flags whether it accepts system messages mid-conversation; if not, `collapseSystemMessages` folds everything into the leading message.

## Findings (pi-ai 1.0.2)

| Model / API | Top-level tools | The change on the wire | Cached prefix |
|---|---|---|---|
| Anthropic, native | `read`, placeholder | `system` message: text diff + `tool_addition` block carrying the full `deploy` definition | kept |
| Anthropic, system only | `read`, `deploy` | `system` message, text only | broken by the tool list |
| Anthropic, collapsed | `read`, `deploy` | folded into the top-level system | broken |
| OpenAI Responses (`additional_tools`) | none (since 1.4.0) | `additional_tools` item + `developer` message | kept |
| OpenAI Responses (tool_search only) | `read` | a synthesized, completed `tool_search_call` / `tool_search_output` pair carrying `deploy`, + `developer` message | kept |
| Kimi, DeepSeek v4-pro (Chat Completions) | `read`, `deploy` | `system` message in place | text kept, tool list breaks it |
| DeepSeek flash (catalog default) | `read`, `deploy` | collapsed | broken |
| Gemini | `read`, `deploy` | collapsed into `systemInstruction` | broken |

Details worth knowing:

- **Placeholder tool.** Anthropic adds hidden scaffolding for mid-conversation tool changes. pi declares `__pi_deferred_placeholder__` (with `defer_loading`) from the first request so that scaffolding is already in the cached prefix when the first real tool arrives.
- **Position.** On Anthropic, pending system messages are emitted right before the next assistant message, because a system message may not sit between `tool_use` and `tool_result`. A change placed before a user message lands after it on the wire. OpenAI and Kimi keep it in place.
- **Effort markers.** The trailing `system: [] output_config={"effort":"high"}` is a mid-conversation reasoning-effort marker (`supportsMidConvoEffort`), the same mechanism.
- **Removals and redefinitions.** Only Anthropic has `tool_removal`, and since 1.0.1 a same-name redefinition is just another inline `tool_addition`. Elsewhere, a removed or redefined tool makes pi resend the full current tool list (`hasNonAdditiveToolChanges`); since 1.4.0, Responses models with `additional_tools` announce removals as text instead (see History).
- **Capabilities are per provider and model.** `claude-fable-5` has native tool changes on Anthropic's API, system messages only on github-copilot/opencode, and neither on openrouter.

Source (v1.0.0): [`ai/src/types.ts`](https://github.com/earendil-works/pi/blob/v1.0.0/packages/ai/src/types.ts) (`SystemMessage`), [`ai/src/utils/transcript.ts`](https://github.com/earendil-works/pi/blob/v1.0.0/packages/ai/src/utils/transcript.ts), [`api/anthropic-messages.ts`](https://github.com/earendil-works/pi/blob/v1.0.0/packages/ai/src/api/anthropic-messages.ts) (`DEFERRED_TOOL_PLACEHOLDER`, `nativeToolChanges`, `pendingSystemMessages`), [`api/openai-responses-shared.ts`](https://github.com/earendil-works/pi/blob/v1.0.0/packages/ai/src/api/openai-responses-shared.ts) (`appendSystemToolAdditions`).

Measured cache effect: [cache-deepseek](../cache-deepseek/NOTES.md).

## History

- **1.0.0**: later Anthropic tools were appended to the top-level list with `defer_loading: true` and activated by a `tool_addition` block that referenced them by name (`tool_reference`). A same-name redefinition could not be expressed and fell back to resending the full tool list.
- **1.0.1** (`b271b0a52`, beta `inline-tools-2026-09-15`): the top-level list never changes after the first request; later tools travel by value inside `tool_addition` (`tool_definition`). Caught by this experiment's snapshot in the first tracking PR (1.0.0 -> 1.0.2).

- **1.4.0** (`caa6967b6`, `530015d93`, [#10940](https://github.com/earendil-works/pi/issues/10940)): on Responses models with both mid-conversation system messages and `additional_tools`, every tool is declared in `additional_tools` items, starting with one at the head of the input; the top-level `tools` list is empty. Problem: `additional_tools` can add or redefine tools from earlier items, but cannot replace a top-level tool or remove any. So in 1.3.0 a removal rewrote the top-level list and lost the prompt cache on every later load. Now a removal is a text notice (`The following tools are no longer available. Do not call them:`), and every later `additional_tools` item follows a `developer` notice (`This is an incremental tools update. ...`), so the model does not read the latest item as the complete tool set. That notice is the new line in this row. Breaking for callers of `resolveTranscriptTools()`, which now takes `"none"`, `"additions"`, or `"changes"`; pi-lab does not call it. Other rows are unchanged.

## Watch on upgrades

Any provider adopting native tool changes (OpenAI, Kimi, DeepSeek), or a catalog flag flipping (for example `supportsMidConvoSystemMessages` on `deepseek-flash`), changes a row of `snapshot.json`.
