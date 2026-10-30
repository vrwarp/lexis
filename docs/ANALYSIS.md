# Recording and analysing runs

Every project keeps a **trace**: a complete, append-only record of what the
engine did, what every agent was asked, what it read, what it did, what it
wrote, and what it cost. The trace exists so that a failure can be explained
after the fact and so that the pipeline can be improved from evidence rather
than impressions. This page says what is recorded, where, and how to ask it
questions.

## What is recorded

`data/projects/<id>/trace/` (outside the git-versioned workspace, invisible
to the agents):

| Path | What |
|---|---|
| `meta.json` | format version, project, lexis / Agent SDK / Claude Code versions, settings at creation |
| `runs.jsonl` | **one record per agent run** — the index everything else hangs off (fields below) |
| `timeline.jsonl` | engine events with timestamps: run state changes with reasons (pauses, limits, restarts), step transitions, concurrency and plan edits, instruction changes, revisions, review decisions, snapshots, re-validations |
| `runs/<runId>/prompt.md` | the exact task prompt the agent received |
| `runs/<runId>/transcript.jsonl` | the agent's whole session: thinking, text, every tool call with its full input, every tool result (what it read; capped per block), sandbox denials, API retries, rate-limit notices, stderr, the final result with usage |
| `blobs/<sha256>` | the content of every input file at the moment a run started and every output file when it ended, deduplicated by content |
| `agents/<name>-<hash>.md` | each version of each agent's system prompt that ever ran, so results can be grouped by prompt version |

A run record (`runs.jsonl`) carries: ids (step, chapter, run), agent, mode,
round and attempt; model, effort and the caps in force; timings (wall,
API, turns); the outcome kind (`ok`, `failed`, `transient`, `limit`,
`auth`, `timeout`, `aborted`) and error text; the harness check (accepted,
rejected with reason, warning, report status); usage per model (input,
output, cache read, cache write, cost); tool calls by tool, denials, API
retries; the inputs and outputs as `{path, hash, size}` with each output's
previous hash (so a run that changed nothing is visible); text metrics for
translated documents (characters, words, paragraphs, script composition);
the first lines of the agent's reply; the agent prompt's hash; the
Claude Code version and session id.

Nothing in the UI feed (`events.jsonl`) is needed for analysis; the trace
is complete on its own. The trace holds the book's text (inputs and
outputs), so treat an export like the book.

## Asking questions

The `trace` command works on a project id (the folder name under
`data/projects/`; the UI's URL and the project list show it):

```sh
docker compose exec lexis node dist/cli.js trace <project> summary     # the overview, fits in a message
docker compose exec lexis node dist/cli.js trace <project> stages      # per stage/mode: counts, rejections, p50/p95, tokens, cache hits, cost
docker compose exec lexis node dist/cli.js trace <project> chapters    # per chapter: rounds, verification, time and cost per 1k words, expansion, scripts
docker compose exec lexis node dist/cli.js trace <project> failures    # every rejected or failed run, grouped by reason, with its transcript path
docker compose exec lexis node dist/cli.js trace <project> timeline    # concurrency utilisation, pauses and why, the serial chains that bound the run
docker compose exec lexis node dist/cli.js trace <project> prompts     # agent prompt versions and how each fared (A/B)
docker compose exec lexis node dist/cli.js trace <project> run <runId> # one run: prompt, check, readable transcript
docker compose exec lexis node dist/cli.js trace <project> export      # a .tgz of the trace to hand over
```

Add `--json` to any listing for machine-readable output. The same data is
served at `GET /api/projects/:id/trace/summary` and the export at
`GET /api/projects/:id/trace/export` (the **Diagnostics** button in the UI).

### Debugging a failed or bad step

1. `trace <project> failures` — find the run; the reason is the harness's
   check or the SDK's error, normalised and grouped so a recurring cause
   stands out (e.g. "lost the XHTML structure" on three chapters means the
   prompt, not the chapter).
2. `trace <project> run <runId>` — read what the agent was told, what it
   read (tool results), what it wrote, and what it said at the end.
3. The inputs and outputs are in `blobs/` by hash: diff the output against
   the previous version of the same file (`prevHash`) to see what a refine or
   fix pass actually changed, or diff a chapter's draft against its final.
4. The timeline says what else was happening: how many runs were in flight,
   whether a rate limit had just hit, whether the step had been restarted.

### Finding improvements

- **Time**: `stages` shows where the wall-clock goes per mode and how wide
  the spread is (p95 ≫ p50 means a few chapters dominate; `chapters` names
  them). `timeline` shows how much of the run had fewer runs in flight than
  the concurrency setting and why: the glossary chain and initialization are
  serial by design; long pauses are rate limits.
- **Cost**: `stages` gives tokens and cost per mode and the cache-hit rate
  (cache reads over all input). A low hit rate on a mode whose prompts are
  stable points at something volatile in the prefix. `chapters` gives cost
  per 1k source words, so an outlier chapter is obvious.
- **Struggle**: loop-round histograms and cap hits (draft/omission,
  stray/fix), verification outcomes, rejections by reason, timeouts,
  turn-cap hits. A stage that often needs a second round on short chapters
  is a prompt problem; one that only does so on long chapters is a size
  problem.
- **Efficiency**: turns and tool calls per run by mode (an agent reading the
  same file three times is wasting turns), API time against wall time,
  "no-change" runs (a fix or refine round whose output hash equals its
  input's — the agent did nothing), expansion ratio and script composition
  of finals (a Chinese final with 30% Latin letters has leaked source text).
- **Prompt changes**: edit an agent prompt, re-run some chapters, and
  `prompts` groups the runs by prompt version with the same metrics side by
  side. Same chapters, same model, different prompt: that is the A/B
  `LESSONS.md` §5 asks for before changing the pipeline.

### Handing it to Claude

`trace <project> summary` is designed to be pasted whole into a
conversation: it is a few dozen lines with the numbers above. For a deeper
look, `trace <project> export` writes `lexis-trace-<project>.tgz` (the trace,
`pipeline.json`, `project.json`, the UI event log); attach it. The trace
format is versioned (`v` on every record); the fields are documented in
`src/engine/trace.ts`.

## Size

Transcripts are text and small. Blobs are deduplicated by content, so an
input read by ten runs is stored once and an unchanged output costs nothing.
A 40-chapter book comes to tens of megabytes. The trace lives and dies with
the project folder.
