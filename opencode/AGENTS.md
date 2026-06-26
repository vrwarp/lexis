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

**No per-agent model pinning.** None of the agents specify a `model:` key; each inherits whatever model the parent/harness is configured to use. This keeps the two harnesses symmetric (Antigravity has no per-agent model slot anyway) and means the model is chosen once, at the harness/session level, rather than per agent.

Quality on a mid-tier (Flash-class) model is therefore carried entirely by the **scaffolding**, not by per-agent tiering: the exemplar prior, the Positive-Constraint Document, zero-generation repair, scene chunking + truncation guard, the `translation-scorer` acceptance gate, special-content handling, and the consistency auditor. See `docs/FLASH_QUALITY_PLAN.md`.

If you later want a stronger model only on the literary-cognition agents (`primary-translator`, `final-translator`, `native-critique`, `metadata-generator`), set the parent/session model accordingly, or re-introduce a `model:` key on those four agents — but the default is to inherit. opencode has no per-agent timeout field either; request timeouts live at provider level.

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
| 2026-06-26 | Flash-quality top-5 (from `docs/FLASH_QUALITY_PLAN.md`, after the Ender's Game benchmark): (#1) exemplar prior — `style-analyzer` embeds `notes/TRANSLATION_EXEMPLARS.md` at the top of `style_guide.md`; literary agents CONTINUE that voice. (#3) `notes/POSITIVE_CONSTRAINTS.md` locked-term table reconciled by `glossary-manager`. (#4) zero-generation repair — detector copies pre-authored replacement sentences, fixer swaps verbatim. (#2) scene chunking — `narrative-summarizer` scene boundaries + orchestrator Step 4.0a per-scene drafting. (#5) truncation guard — detector `STATUS: TRUNCATION_ARTIFACT` + scene-retry + `ebook-packager` pre-packaging integrity gate. | Global | Close the Flash-vs-Pro literary gap (dynamic equivalence, slang, domain terms, register, completeness) via scaffolding, not a bigger model |
| 2026-06-26 | NOTE: `notes/TRANSLATION_EXEMPLARS.md` and `notes/POSITIVE_CONSTRAINTS.md` are **operator-authored once per book** (see `lexical-management` skill §5). They are optional; the pipeline runs without them but Flash register/terminology quality is materially lower. Authoring them is the highest-leverage human step. | Operator | These assets carry the literary judgment Flash lacks |
| 2026-06-26 | Removed all per-agent `model:` pins — every agent now inherits the parent/harness default model; model is chosen once at the harness/session level | Global | Simplify and make both harnesses symmetric; quality is carried by scaffolding, not per-agent tiering |