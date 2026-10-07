# Release analyst

A small application built on [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable): when a pi upgrade changes experiment results, it explains each change from pi's changelogs and code and drafts the NOTES.md updates and a pull request summary. It is both a pi-lab tool and a hands-on test of pi-durable as a framework.

```bash
GITHUB_TOKEN=$(gh auth token) node --env-file=.env analyst/analyze.ts \
  --report report.md --from 1.0.2 --to 1.0.4
```

`report.md` is the report `npm run exp -- --offline --report report.md` writes, which is also the body of a tracking PR. Output goes to `.tmp/analyst/<from>-<to>/`: `summary.md` and one draft per changed experiment. Needs `DEEPSEEK_API_KEY`; `GITHUB_TOKEN` avoids GitHub's 60 requests an hour for unauthenticated calls.

## Design

```
lead conversation (deepseek-v4-pro): reads the report
  └─ analyze_experiment × N, in parallel                    tool call = durable task, replay: "safe"
       └─ subagent conversation owned by that task (deepseek-flash)
            read_notes · changelog · commits · commit_diff · read_source · write_draft
  └─ writes summary.md
storage: SQLite (.tmp/analyst/<from>-<to>.sqlite)
```

| pi-durable feature | How the analyst uses it |
|---|---|
| Durable tasks and checkpoints | Every model request and tool call is a task; a killed run resumes from its last checkpoint |
| `requestId` | The lead's submission is `release:<from>-><to>`, a subagent's `analyze:<taskId>`: a rerun finds them instead of submitting again |
| Task-owned conversations | A subagent is a conversation owned by its `analyze_experiment` task; a rerun looks it up by owner before creating one (the pattern of pi's example 22) |
| `replay: "safe"` | All tools are reads or overwrites, so they may rerun after a crash |
| Per-conversation agent | The lead and the subagents have their own model, tools, and instructions (`configure()`) |
| `toolExecution: "parallel"` | Subagents for different experiments run at the same time |

The report section with an experiment's diff is cut out by code and handed to its subagent, not left for a model to find.

## Evaluation (the 1.0.0 -> 1.0.2 tracking PR)

[`fixtures/report-1.0.0-1.0.2.md`](fixtures/report-1.0.0-1.0.2.md) is the body of tracking PR #1, whose causes are known: Anthropic's inline mid-conversation tools (`b271b0a52`), and the faux provider double-counting cache writes once pi-durable passes a `sessionId` (traced by hand in [durable-examples](../experiments/durable-examples/NOTES.md)).

| Run | Result |
|---|---|
| NOTES.md as of today | Both causes right, but the notes already contained them: the run only restated them. Not a valid test |
| Blind (`--notes-rev 993e8ae`, notes from before PR #1), changelog only | midconvo-requests right. durable-examples: found the `sessionId` changelog entry, judged it unrelated, and reported **"cause not found"** instead of guessing |
| Blind, with `commits`, `commit_diff`, `read_source` | **Both right.** For durable-examples it traced `70eceaade`, the faux provider's `input` + `cacheWrite`, and `calculateContextTokens`, and found two details not traced by hand: documents share the ID counter with entries (why 20-inbox IDs shift by one), and the same commit set `cacheRetention: "none"` in the compaction tests, sidestepping the faux cache simulation there. Every quoted line was checked against the source |

Crash test: killed after 20 s with one of two drafts written, then rerun with the same command. It finished in 19 s with the same three conversations and three submissions as before the crash: no subagent ran twice.

## Limits

- Answers depend on the models; quoted code and changelog lines should be checked before NOTES are updated. The drafts are proposals.
- The `changelog` tool reads `packages/*/CHANGELOG.md` at the release tag on GitHub, because the npm packages of pi-ai and pi-codemode do not ship one.
