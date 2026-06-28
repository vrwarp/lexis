# Agent Orchestration Guide

This document outlines the trigger rules and changelogs for the `lexis` translation team.

## Harness: lexis

**Goal:** Translate EPUB books sequentially chapter-by-chapter with strict glossary consolidation, error-checked validation, and critique.

**Trigger:** Use the `lexis-orchestrator` skill to run, manage, update, or check status on any task related to book translation, EPUB disbinding/packaging, glossary management, or translation production. Simple questions may be answered directly.

## Model Tier Strategy

**No per-agent model selection.** Every agent inherits whatever model the parent/harness is configured to use; the model is chosen once at the harness/session level. Antigravity's per-agent `agent.json` has no model slot anyway (`config.customAgent` exposes only `systemPromptSections`, `toolNames`, `systemPromptConfig`; `settings.json` → `agents.overrides.<name>` exposes only `{enabled: bool}`), so this is the natural, symmetric behavior across both harnesses — there is no longer any per-agent model divergence to reconcile.

Quality on a mid-tier (Flash-class) model is carried by the pipeline **scaffolding** (exemplar prior, Positive-Constraint Document, zero-generation repair, scene chunking + truncation guard, the `translation-scorer` gate, special-content handling, consistency auditor) — not by per-agent tiering. To use a stronger model on the literary agents, set the harness/session model accordingly. See `docs/FLASH_QUALITY_PLAN.md`.

**Change Log:**
| Date | Change | Scope | Reason |
| :--- | :--- | :--- | :--- |
| 2026-06-21 | Migrated legacy frontmatter-based md agents to standard subagent plugin structure under `agents/plugins/lexis-plugin/` | Global | Rebuild repository pipeline for shared Git tracking |
| 2026-06-26 | Documented Antigravity model-pin asymmetry as accepted divergence; opencode re-pins per-agent `model:`, Antigravity uses harness-default (no per-agent model slot in agent.json/settings.json) | Global | Re-establish model-tier strategy where the harness can express it; record the structural blocker where it cannot |
| 2026-06-26 | Added `translation-scorer` (15th agent): markdown scorecard with `SCORE_VERDICT:` sentinel (Adequacy/Fluency/Style); orchestrator Step 4.0 post-draft score, Step 4.5 post-finalization regression gate, Phase 5 pre-packaging quality summary | Global | Add an external quality acceptance gate so a mid-tier workhorse is verified, not assumed |
| 2026-06-26 | Added special-content handling chain (footnotes/tables/verse/ruby/captions) across `narrative-summarizer` → `primary-translator` → `native-critique` → `final-translator` | Global | Preserve non-prose fidelity a flat-prose pipeline would silently corrupt |
| 2026-06-26 | Set Flash as the workhorse default for all agents (opencode pins); Pro documented as evidence-gated escalation for the four literary agents | Global | Deliver high-quality translation on a mid-tier model, quality carried by scaffolding + scorer gate |
| 2026-06-26 | Added `consistency-auditor` (16th agent): book-wide terminology/honorific/register audit (`notes/consistency_report.md`, `STATUS:` sentinel) run once before packaging (orchestrator Phase 4.6 + Phase 5 gate) | Global | Catch cross-chapter drift the per-chapter agents structurally cannot see |
| 2026-06-26 | Flash-quality top-5 (from `docs/FLASH_QUALITY_PLAN.md`): exemplar prior (`TRANSLATION_EXEMPLARS.md` → `style_guide.md`, literary agents continue the voice); `POSITIVE_CONSTRAINTS.md` locked-term table; zero-generation repair (detector copies replacement sentences, fixer swaps verbatim); scene chunking (scene boundaries + orchestrator Step 4.0a per-scene drafting, greps routed via `stray-phrase-detector`); truncation guard (`STATUS: TRUNCATION_ARTIFACT` + scene-retry + `ebook-packager` pre-packaging integrity gate) | Global | Close the Flash-vs-Pro literary gap via scaffolding |
| 2026-06-26 | NOTE: `TRANSLATION_EXEMPLARS.md` and `POSITIVE_CONSTRAINTS.md` are operator-authored once per book (see `lexical-management` skill §5); optional but the highest-leverage human quality step | Operator | These assets carry the literary judgment Flash lacks |
| 2026-06-26 | Removed all per-agent `model:` pins (opencode); every agent now inherits the parent/harness default model — both harnesses are now symmetric (no model divergence) | Global | Choose the model once at the harness/session level; quality is carried by scaffolding, not per-agent tiering |
| 2026-06-26 | Per-scene translation redesign — cheap bundle (C1–C4) + structural bet (C5–C10, S1, S2): register-matched exemplars, in-scene Glossary Reminder, calque-prohibition block, committed forms, paragraph-parity drafting + voice re-anchor, deterministic structure/negation/particle gates, gated particle-retranslation (Step 4.2b), scene-scoped omission repair (Step 4.1), Name Confirmation Gate (Phase 3.5) | Global | Fix per-scene one-shot failures upstream/deterministically; see `docs/ONESHOT_TRANSLATION_DESIGN.md` |
| 2026-06-27 | Generalization (lean core): added `language-profiler` (17th agent) → `notes/language_profile.md`; de-hardcoded zh/Ender literals across the agents/skills/orchestrator (now illustrative en→zh-TW examples); parameterized every deterministic check by the profile with loud SKIP/LOW_CONFIDENCE degradation; zh-TW worked-example fixture under `docs/examples/en-zh-TW/`; full deferred design in `docs/GENERALIZATION_DESIGN.md` | Global | Support arbitrary books and arbitrary source→target language pairs without regressing zh-TW |
