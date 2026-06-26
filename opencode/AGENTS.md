# Agent Orchestration Guide — lexis (opencode)

This document outlines the trigger rules and changelogs for the `lexis` translation team.

## Harness: lexis

**Goal:** Translate EPUB books sequentially chapter-by-chapter with strict glossary consolidation, error-checked validation, and critique.

**Trigger:** Use the `lexis-orchestrator` skill to run, manage, update, or check status on any task related to book translation, EPUB disbinding/packaging, glossary management, or translation production. Simple questions may be answered directly.

## Subagents

The 16 subagents live under `.opencode/agents/`. All are `mode: subagent` and are invoked by the orchestrator skill:

| Agent | Role / Phase |
| :--- | :--- |
| `ebook-disbinder` | Preparation — extract EPUB to `original/` |
| `toc-generator` | Init — `notes/contents.json` |
| `style-analyzer` | Init — `notes/style_guide.md` |
| `metadata-generator` | Init — `notes/metadata.json` |
| `narrative-summarizer` | Stage A extraction — per-chapter summaries, challenges & special-content inventory |
| `local-lexicographer` | Stage A extraction — per-chapter lexicon |
| `glossary-manager` | Stage A consolidation — `master_glossary.json` |
| `primary-translator` | Stage B draft — `draft/<name>` (applies special-content strategies) |
| `translation-scorer` | Stage B quality gate — `notes/<name>.score.md` (draft) & `notes/<name>.final.score.md` (post-finalization regression gate) |
| `omission-detector` | Stage B validation — omission reports |
| `stray-phrase-detector` | Stage B validation — stray phrase reports |
| `stray-phrase-fixer` | Stage B validation — patch draft |
| `native-critique` | Stage B refinement — `critique/<name>.critique.md` (exempts special content) |
| `final-translator` | Stage B finalization — `final/<name>` (special-content hard constraint) |
| `consistency-auditor` | Finalization (book-wide, once) — `notes/consistency_report.md` (terminology/honorific/register drift) |
| `ebook-packager` | Finalization — `translated_book.epub` |

## Skills

Skills live under `.opencode/skills/`:

- `lexis-orchestrator` — coordinates the pipeline
- `epub-handling` — EPUB unzip/zip procedures
- `lexical-management` — glossary & metadata procedures
- `narrative-translation` — drafting & finalization procedures
- `translation-validation` — omission & stray-phrase auditing procedures

## Model Tier Strategy

Per-agent model pinning is expressed via the `model:` frontmatter key (format `provider/model-id`, verified against opencode docs).

**Flash-as-workhorse (current default).** Per the project goal — high-quality literary translation on a mid-tier model — **all 16 agents are pinned to `google/gemini-3-flash-preview`**. Quality is carried by the scaffolding (the `translation-scorer` acceptance gate, special-content handling, robust Markdown sentinels, glossary consistency audit), not by a larger model.

| Tier | Model | Agents |
| :--- | :--- | :--- |
| Flash (workhorse) | `google/gemini-3-flash-preview` | **all 16 agents** |

**Documented Pro-escalation (not the default).** The repo's prior baseline (`ba86672`) ran the four literary-cognition agents — `primary-translator`, `final-translator`, `native-critique`, `metadata-generator` — on `google/gemini-3-pro-preview`. That remains the recommended escalation tier: if a quality benchmark (or the `translation-scorer` gate firing `FAIL` repeatedly) shows Flash underperforming on those agents, re-pin them to Pro, or escalate only the below-threshold chapters. Treat any such tier change as evidence-gated.

Notes: opencode has **no per-agent timeout field** — the legacy `timeout_mins:` was never consumed; request timeouts live at provider level (`provider.<name>.options.timeout`, ms) and are intentionally not set per-agent. The Antigravity harness cannot express per-agent model selection (no model slot in `agent.json`/`settings.json`) and runs custom agents on the harness default — see `antigravity/AGENTS.md` (accepted divergence).

## Change Log:
| Date | Change | Scope | Reason |
| :--- | :--- | :--- | :--- |
| 2026-06-21 | Migrated legacy frontmatter-based md agents to standard subagent plugin structure under `agents/plugins/lexis-plugin/` (Antigravity) | Global | Rebuild repository pipeline for shared Git tracking |
| 2026-06-24 | Forked opencode harness under `opencode/`; Antigravity harness preserved under `antigravity/` | Global | Support both Google Antigravity and opencode runtimes |
| 2026-06-26 | Re-pinned per-agent `model:` frontmatter (Pro/Flash/default per ba86672 map, `google/` provider prefix); dropped never-consumed `timeout_mins:` | opencode | Re-establish testable model-tier strategy; Antigravity asymmetry recorded as accepted divergence |
| 2026-06-26 | Added `translation-scorer` (15th agent, Flash): markdown scorecard with `SCORE_VERDICT:` sentinel scoring Adequacy/Fluency/Style; wired into orchestrator as Step 4.0 (post-draft score) + Step 4.5 (post-finalization regression gate) + Phase 5 pre-packaging quality summary | Global | Add an external quality signal / acceptance gate so a mid-tier workhorse is verified, not assumed |
| 2026-06-26 | Added special-content handling chain (footnotes/tables/verse/ruby/captions): `narrative-summarizer` inventories per-type strategies into `challenges.md`; `primary-translator` applies them; `native-critique` exempts their structure; `final-translator` hard-constrains against structurally-destructive critique | Global | Preserve non-prose fidelity that a flat-prose pipeline would silently corrupt |
| 2026-06-26 | Set all agents to Flash (`google/gemini-3-flash-preview`) as the workhorse default; documented Pro as the evidence-gated escalation tier for the four literary agents | opencode | Deliver the stated goal: high-quality translation on a mid-tier model, with quality carried by scaffolding + the scorer gate |
| 2026-06-26 | Added `consistency-auditor` (16th agent, Flash): book-wide terminology/honorific/register audit (`notes/consistency_report.md`, `STATUS:` sentinel) run once before packaging (orchestrator Phase 4.6 + Phase 5 gate) | Global | Catch cross-chapter drift the per-chapter agents structurally cannot see |