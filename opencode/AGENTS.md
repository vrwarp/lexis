# Agent Orchestration Guide — lexis (opencode)

This document outlines the trigger rules and changelogs for the `lexis` translation team.

## Harness: lexis

**Goal:** Translate EPUB books sequentially chapter-by-chapter with strict glossary consolidation, error-checked validation, and critique.

**Trigger:** Use the `lexis-orchestrator` skill to run, manage, update, or check status on any task related to book translation, EPUB disbinding/packaging, glossary management, or translation production. Simple questions may be answered directly.

## Subagents

The 14 subagents live under `.opencode/agents/`. All are `mode: subagent` and are invoked by the orchestrator skill:

| Agent | Role / Phase |
| :--- | :--- |
| `ebook-disbinder` | Preparation — extract EPUB to `original/` |
| `toc-generator` | Init — `notes/contents.json` |
| `style-analyzer` | Init — `notes/style_guide.md` |
| `metadata-generator` | Init — `notes/metadata.json` |
| `narrative-summarizer` | Stage A extraction — per-chapter summaries & challenges |
| `local-lexicographer` | Stage A extraction — per-chapter lexicon |
| `glossary-manager` | Stage A consolidation — `master_glossary.json` |
| `primary-translator` | Stage B draft — `draft/<name>` |
| `omission-detector` | Stage B validation — omission reports |
| `stray-phrase-detector` | Stage B validation — stray phrase reports |
| `stray-phrase-fixer` | Stage B validation — patch draft |
| `native-critique` | Stage B refinement — `critique/<name>.critique.md` |
| `final-translator` | Stage B finalization — `final/<name>` |
| `ebook-packager` | Finalization — `translated_book.epub` |

## Skills

Skills live under `.opencode/skills/`:

- `lexis-orchestrator` — coordinates the pipeline
- `epub-handling` — EPUB unzip/zip procedures
- `lexical-management` — glossary & metadata procedures
- `narrative-translation` — drafting & finalization procedures
- `translation-validation` — omission & stray-phrase auditing procedures

## Model Tier Strategy

Per-agent model pinning is expressed via the `model:` frontmatter key (format `provider/model-id`, verified against opencode docs). The Flash-workhorse / Pro-quality split:

| Tier | Model | Agents |
| :--- | :--- | :--- |
| Pro | `google/gemini-3-pro-preview` | `primary-translator`, `final-translator`, `native-critique`, `metadata-generator` |
| Flash | `google/gemini-3-flash-preview` | `ebook-disbinder`, `ebook-packager`, `omission-detector`, `stray-phrase-detector`, `stray-phrase-fixer` |
| Default | (no `model:` key — harness default) | `toc-generator`, `style-analyzer`, `narrative-summarizer`, `local-lexicographer`, `glossary-manager` |

Notes: opencode has **no per-agent timeout field** — the legacy `timeout_mins:` was never consumed; request timeouts live at provider level (`provider.<name>.options.timeout`, ms) and are intentionally not set per-agent. The Antigravity harness cannot express this split (no model slot in `agent.json`/`settings.json`) and runs custom agents on the harness default — see `antigravity/AGENTS.md` (accepted divergence). Re-pinning is the evidence-gated baseline; any demotion of a tier must be justified by quality evidence.

## Change Log:
| Date | Change | Scope | Reason |
| :--- | :--- | :--- | :--- |
| 2026-06-21 | Migrated legacy frontmatter-based md agents to standard subagent plugin structure under `agents/plugins/lexis-plugin/` (Antigravity) | Global | Rebuild repository pipeline for shared Git tracking |
| 2026-06-24 | Forked opencode harness under `opencode/`; Antigravity harness preserved under `antigravity/` | Global | Support both Google Antigravity and opencode runtimes |
| 2026-06-26 | Re-pinned per-agent `model:` frontmatter (Pro/Flash/default per ba86672 map, `google/` provider prefix); dropped never-consumed `timeout_mins:` | opencode | Re-establish testable model-tier strategy; Antigravity asymmetry recorded as accepted divergence |