# lexis

A multi-stage sequential book-translation orchestration pipeline designed to produce **high-quality literary translation using a mid-tier (Gemini Flash–class) model as the workhorse**. Lexis disbinds an EPUB, builds a glossary chapter-by-chapter, drafts and validates translations, scores each chapter against an explicit quality gate, applies native critique, and packages a finished `translated_book.epub`. Quality comes from decomposition, context engineering, external-signal verification, and quality gates — scaffolding, not model size.

This repo ships **two runtime harnesses** that share the same 15 agents and 5 skills:

| Harness | Directory | Config | Agents | Skills |
| :--- | :--- | :--- | :--- | :--- |
| Google Antigravity | [`antigravity/`](./antigravity) | `settings.json`, `AGENTS.md` | `agents/plugins/lexis-plugin/agents/<name>/agent.json` (customAgent JSON) | `agents/plugins/lexis-plugin/skills/<name>/SKILL.md` |
| opencode | [`opencode/`](./opencode) | `opencode.json`, `AGENTS.md` | `.opencode/agents/<name>.md` (markdown frontmatter) | `.opencode/skills/<name>/SKILL.md` |

## Usage

- **Antigravity:** Copy the contents of `antigravity/` into your project root. Antigravity discovers the `lexis-plugin` plugin and its agents/skills automatically.
- **opencode:** Copy the contents of `opencode/` into your project root. opencode discovers agents under `.opencode/agents/` and skills under `.opencode/skills/`, and loads `opencode.json` + `AGENTS.md` as instructions.

## The 15 Subagents

`ebook-disbinder` · `toc-generator` · `style-analyzer` · `metadata-generator` · `narrative-summarizer` · `local-lexicographer` · `glossary-manager` · `primary-translator` · `translation-scorer` · `omission-detector` · `stray-phrase-detector` · `stray-phrase-fixer` · `native-critique` · `final-translator` · `ebook-packager`

## The 5 Skills

`lexis-orchestrator` (coordinates the pipeline) · `epub-handling` · `lexical-management` · `narrative-translation` · `translation-validation`

## Pipeline Overview

1. **Stage A** (per-chapter, sequential): summarize (+ inventory special content) → extract lexicon → consolidate master glossary.
2. **Stage B** (per-chapter, sequential): draft → **quality score** → omission loop → stray-phrase loop → native critique → finalize → **post-finalization regression gate**.
3. **Packaging:** present a per-chapter quality summary, gate on it, then synchronize assets, localize metadata, and repackage into `translated_book.epub`.

## Design notes for mid-tier (Flash) quality

- **Explicit model-tier strategy.** Per-agent `model:` pins (opencode frontmatter); Antigravity runs harness-default (no per-agent model slot — documented divergence). See each `AGENTS.md`.
- **Quality gate.** `translation-scorer` emits a markdown scorecard (Adequacy/Fluency/Style) ending in a `SCORE_VERDICT:` sentinel, used post-draft and as a post-finalization regression gate; a `FAIL` blocks silent progress and packaging.
- **Robust structured output.** Reports are Markdown with single trailing `STATUS:`/`SCORE_VERDICT:` sentinels read tolerantly (last line, case-insensitive, fail-safe on malformation) — JSON is reserved for `master_glossary.json` only, since forcing JSON degrades mid-tier prose.
- **Special-content fidelity.** Footnotes, tables, verse, ruby, and captions get per-type strategies threaded through summarizer → translator → critique → finalizer.

See `docs/` for the redesign blueprint, the SOTA research digest, and the full ideation/critique loop ledger. See the `lexis-orchestrator` skill for the full workflow, error-handling, and loop thresholds.