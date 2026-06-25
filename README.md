# lexis

A multi-stage sequential book-translation orchestration pipeline. Lexis disbinds an EPUB, builds a glossary chapter-by-chapter, drafts and validates translations, applies native critique, and packages a finished `translated_book.epub`.

This repo ships **two runtime harnesses** that share the same 14 agents and 5 skills:

| Harness | Directory | Config | Agents | Skills |
| :--- | :--- | :--- | :--- | :--- |
| Google Antigravity | [`antigravity/`](./antigravity) | `settings.json`, `AGENTS.md` | `agents/plugins/lexis-plugin/agents/<name>/agent.json` (customAgent JSON) | `agents/plugins/lexis-plugin/skills/<name>/SKILL.md` |
| opencode | [`opencode/`](./opencode) | `opencode.json`, `AGENTS.md` | `.opencode/agents/<name>.md` (markdown frontmatter) | `.opencode/skills/<name>/SKILL.md` |

## Usage

- **Antigravity:** Copy the contents of `antigravity/` into your project root. Antigravity discovers the `lexis-plugin` plugin and its agents/skills automatically.
- **opencode:** Copy the contents of `opencode/` into your project root. opencode discovers agents under `.opencode/agents/` and skills under `.opencode/skills/`, and loads `opencode.json` + `AGENTS.md` as instructions.

## The 14 Subagents

`ebook-disbinder` · `toc-generator` · `style-analyzer` · `metadata-generator` · `narrative-summarizer` · `local-lexicographer` · `glossary-manager` · `primary-translator` · `omission-detector` · `stray-phrase-detector` · `stray-phrase-fixer` · `native-critique` · `final-translator` · `ebook-packager`

## The 5 Skills

`lexis-orchestrator` (coordinates the pipeline) · `epub-handling` · `lexical-management` · `narrative-translation` · `translation-validation`

## Pipeline Overview

1. **Stage A** (per-chapter, sequential): summarize → extract lexicon → consolidate master glossary.
2. **Stage B** (per-chapter, sequential): draft → omission loop → stray-phrase loop → native critique → finalize.
3. **Packaging:** synchronize assets, localize metadata, repackage into `translated_book.epub`.

See the `lexis-orchestrator` skill for the full workflow, error-handling, and loop thresholds.