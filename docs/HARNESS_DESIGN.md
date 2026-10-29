# The lexis harness: a code-driven pipeline

This describes how lexis runs the translation pipeline since the
"engine" rework, and why. The *pipeline* (which agents exist, what each one
reads and writes, the model tiers, the stage order, the loop caps) is the
last known good design from [`LESSONS.md`](LESSONS.md) and is unchanged. What
changed is **who sequences it**.

## The problem with an LLM orchestrator

Until this rework an orchestrator agent (Sonnet) drove the whole book: it
read a system prompt describing the pipeline, launched each subagent with a
Task call, checked outputs, and reported progress by calling `report_progress`
when it remembered to. That has four costs that grow with the length of the
book:

- **Reliability.** Every rule ("do not batch chapters", "cap the omission loop
  at 3 rounds", "verify the file exists", "call report_progress") was an
  exhortation. The orchestrator could skip a stage, run two chapters at once,
  loop past the cap, or claim a file it had not checked. A 30-chapter book is
  ~300 Task calls in one context; after compaction it no longer remembers
  what it did.
- **Predictability.** The task prompt each subagent received was composed
  fresh by the orchestrator every time, so the same stage on two chapters
  could be asked for differently.
- **Visibility.** The UI knew only what the orchestrator chose to report.
  If it forgot `report_progress`, the board stalled while work continued; a
  failure inside a subagent surfaced only if the orchestrator narrated it.
- **Speed.** Each stage cost an orchestrator turn to decide, compose, launch,
  then read the result and verify — Sonnet overhead on every one of the ~10
  stages per chapter, on an ever-growing context. And everything was strictly
  serial: one subagent at a time, one chapter at a time, even where chapters
  are independent.

## What runs now

The sequencing lives in `src/engine/` as ordinary code. The LLM does only the
per-step work the agents were always doing.

```
prepare (code)        unzip, parse the OPF, build the chapter plan, contents.json
init    (LLM, serial) metadata-generator → style-analyzer → critique-charter-generator
extract (LLM, ‖)      per chapter: narrative-summarizer ‖ local-lexicographer
consolidate (serial)  glossary-manager, chapters in reading order, pipelined behind extract
   ── barrier: every chapter consolidated, init complete ──
produce (LLM, ‖ by chapter, serial within one)
                      draft ⇄ omission audit (≤3 rounds)
                      stray scan ⇄ fix (≤3 rounds)
                      native critique → final polish → verification → ≤1 fix
   ── review gate: you approve or ask for another pass ──
package               asset sync (code) → ebook-packager localizes OPF/nav (LLM)
                      → zip, validate, cover override (code)
```

Each agent run is its own `query()` call: the agent's prompt is the system
prompt, a **templated task prompt** names the exact files to read and write,
the tools are the agent's own file tools (sandboxed to the workspace by a
PreToolUse hook), with a turn cap, a dollar cap and a wall-clock timeout.
There is no orchestrator context to overflow and no overhead turn between
steps.

Three steps that were LLM calls are now code, because they are mechanical
and were the least predictable part of a run: extracting the EPUB
(`ebook-disbinder`), deciding the chapter list and order (`toc-generator`),
and zipping the result (the tail of `ebook-packager`). The reading order is
the EPUB spine; titles come from the nav document; documents with no text
(cover pages) are excluded by default. You can see and edit this plan in the
UI before and during the run.

### Reliability

- **Outputs are verified in code** after every agent run: the file exists,
  JSON parses, reports carry their status marker, drafts keep the XHTML
  structure of the original. A failed check retries once with the reason
  appended to the task prompt; then the step is marked failed, the chapter is
  blocked, and the rest of the book continues.
- **Loop decisions are read from the files** the agents already write
  (`STATUS: COMPLETE`, `"status": "CLEAN"`, `STATUS: PASS`), and the caps are
  enforced. Hitting a cap is recorded as a warning on the chapter, not
  silently.
- **Failures are classified.** Rate limits and overloads pause the run and
  resume on a timer (the subscription's reset time when Claude reports one);
  timeouts and bad outputs retry; a user Stop aborts cleanly.
- **The run is resumable.** State is in `pipeline.json` and re-validated
  against the workspace on load, so a restart (or a version revert) continues
  from what actually exists on disk. A step that was running at the restart
  simply runs again.

### Predictability

- The plan (chapters × stages) is computed once from the EPUB and shown before
  anything is translated. The same book produces the same steps in the same
  order.
- Every task prompt is a template with the project's instructions and the
  chapter's note filled in; the exact prompt is stored with the run so you can
  see what the agent was told.
- Settings are fixed for a run and recorded in it: models, effort,
  concurrency, loop caps, per-step caps.

### Visibility

- A **chapter × stage matrix** shows every step's state (pending, running,
  done, failed, skipped), rounds taken, duration and cost; clicking a cell
  opens that step's own log — the agent's text, its tool calls, the exact
  task prompt — and offers retry or re-run from here.
- Progress, ETA (from this run's own step durations) and cost per chapter,
  per stage and per model come from the engine, not from the model's
  narration.
- The review gate's summary is assembled from the state: what finished,
  which chapters hit a loop cap or still had verification issues, glossary
  size.

### Steering

- **Pause / resume / stop**, and a **concurrency** control you can change
  mid-run.
- **Retry** a failed step; **re-run a chapter from any stage** (another polish
  pass, or a full retranslation) with a note that goes into its prompts.
- **Instructions** (the project-wide context) are editable mid-run and reach
  every step that starts afterwards; **chapter notes** do the same for one
  chapter.
- **Chapter plan**: include or exclude chapters before they enter production.
- The review gate takes revision instructions for all chapters or a chosen
  few, and lets you choose another polish pass or a retranslation.
- The **assistant** chat is still there for questions and free-form fixes,
  but it no longer drives the pipeline: it can read the workspace, edit the
  notes (for example lock a glossary term), and ask the engine to re-run
  chapters — all of which then shows up in the matrix like any other work.

### Speed

- **No orchestrator overhead**: no Sonnet turn between steps, no growing
  context. On a long book this alone removes a large share of wall-clock
  time.
- **Parallel extraction** and **parallel production**, bounded by the
  concurrency setting (default 3). Production-stage agents read only their
  own chapter plus the frozen `notes/`, never another chapter's draft, so
  running chapters side by side changes nothing about what any agent sees
  (the glossary barrier from `LESSONS.md` §2 stays absolute). Consolidation
  stays serial in reading order, pipelined behind extraction.
- **Mechanical steps in code** (extract, plan, asset sync, zip) take
  milliseconds instead of an agent run each.
- **Stable prompts** per agent (the system prompt never changes, the task
  prompt is a template) keep the prompt cache warm across steps.

On a subscription, concurrency trades against rate limits: the engine backs
off and pauses when Claude says so, and resumes by itself.

## What deliberately did not change

- The thirteen agents' prompts, apart from mechanics (which tool scans for
  stray script; that the harness mirrors assets and zips).
- Model tiers: the strong model on the translation-quality tier, the cheap
  one on mechanical work (`LESSONS.md` §1).
- Chapters are translated whole, never chunked (§3). Parallelism is across
  chapters, never within one.
- The glossary barrier (§2), the loop caps, the single bounded verification
  pass, and the absence of any LLM "quality gate" (§4).
