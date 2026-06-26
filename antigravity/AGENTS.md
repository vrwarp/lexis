# Agent Orchestration Guide

This document outlines the trigger rules and changelogs for the `lexis` translation team.

## Harness: lexis

**Goal:** Translate EPUB books sequentially chapter-by-chapter with strict glossary consolidation, error-checked validation, and critique.

**Trigger:** Use the `lexis-orchestrator` skill to run, manage, update, or check status on any task related to book translation, EPUB disbinding/packaging, glossary management, or translation production. Simple questions may be answered directly.

## Model Tier Strategy (intended) and the Antigravity asymmetry

The intended per-agent tiering — Pro for `primary-translator`, `final-translator`, `native-critique`, `metadata-generator`; Flash for `ebook-disbinder`, `ebook-packager`, `omission-detector`, `stray-phrase-detector`, `stray-phrase-fixer`; harness default for the rest — is **expressed only in the opencode harness** via the `model:` frontmatter key (`model: google/gemini-3-<tier>-preview`).

**Accepted harness divergence:** Antigravity's per-agent definition (`agent.json` → `config.customAgent` exposes only `systemPromptSections`, `toolNames`, `systemPromptConfig`) has **no model slot**, and `settings.json` → `agents.overrides.<name>` exposes only `{enabled: bool}` — no model picker. Per Gemini-API custom-agent docs, model is fixed by the `base_agent` harness, not selectable per plugin agent. Antigravity custom agents therefore run on the **harness-default model** and the Flash/Pro split is, as of this loop, **unexpressible** on the Antigravity side. This is a known, accepted divergence (see SP22 parity is semantic, not byte-equal); do not attempt to encode `model:`/`timeout` into `agent.json`. Revisit if Antigravity adds a per-agent model field, a plugin-manifest model map, or a workspace per-agent override.

**Change Log:**
| Date | Change | Scope | Reason |
| :--- | :--- | :--- | :--- |
| 2026-06-21 | Migrated legacy frontmatter-based md agents to standard subagent plugin structure under `agents/plugins/lexis-plugin/` | Global | Rebuild repository pipeline for shared Git tracking |
| 2026-06-26 | Documented Antigravity model-pin asymmetry as accepted divergence; opencode re-pins per-agent `model:`, Antigravity uses harness-default (no per-agent model slot in agent.json/settings.json) | Global | Re-establish model-tier strategy where the harness can express it; record the structural blocker where it cannot |
| 2026-06-26 | Added `translation-scorer` (15th agent): markdown scorecard with `SCORE_VERDICT:` sentinel (Adequacy/Fluency/Style); orchestrator Step 4.0 post-draft score, Step 4.5 post-finalization regression gate, Phase 5 pre-packaging quality summary | Global | Add an external quality acceptance gate so a mid-tier workhorse is verified, not assumed |
| 2026-06-26 | Added special-content handling chain (footnotes/tables/verse/ruby/captions) across `narrative-summarizer` → `primary-translator` → `native-critique` → `final-translator` | Global | Preserve non-prose fidelity a flat-prose pipeline would silently corrupt |
