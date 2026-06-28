# Agent Orchestration Guide — lexis (opencode)

This document outlines the trigger rules and changelogs for the `lexis` translation team.

## Harness: lexis

**Goal:** Translate EPUB books sequentially chapter-by-chapter with strict glossary consolidation, error-checked validation, and critique.

**Trigger:** Use the `lexis-orchestrator` skill to run, manage, update, or check status on any task related to book translation, EPUB disbinding/packaging, glossary management, or translation production. Simple questions may be answered directly.

## Subagents

The 17 subagents live under `.opencode/agents/`. All are `mode: subagent` and are invoked by the orchestrator skill:

| Agent | Role / Phase |
| :--- | :--- |
| `ebook-disbinder` | Preparation — extract EPUB to `original/` |
| `toc-generator` | Init — `notes/contents.json` |
| `style-analyzer` | Init — `notes/style_guide.md` |
| `metadata-generator` | Init — `notes/metadata.json` |
| `language-profiler` | Init — `notes/language_profile.md` (per-language-pair config driving all deterministic checks) |
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
| 2026-06-26 | Per-scene translation redesign — cheap bundle (C1–C4): inline calque-prohibition block, Name Confirmation Gate (Phase 3.5), named BAD/GOOD anti-patterns, advisory structure-deficit | Global | Fix per-scene one-shot failures upstream of generation / via deterministic checks (see `docs/ONESHOT_TRANSLATION_DESIGN.md`) |
| 2026-06-26 | Per-scene translation redesign — structural bet (C5–C10, S1, S2): register-tagged scenes + register-matched exemplars; in-scene Glossary Reminder (Step 4.0a grep); Committed Forms & Domain Alerts; paragraph-parity drafting with voice re-anchor; advisory negation/paragraph-elision gates; particle gate + gated particle-retranslation (Step 4.2b, cap 1, revert); scene-scoped omission repair (Step 4.1); reverse-seam INFO flag | Global | Raise per-scene quality on a mid-tier model without extra happy-path calls; the one added conditional call is externally-triggered + gated |
| 2026-06-27 | Generalization (lean core): added `language-profiler` (17th agent) → `notes/language_profile.md`; de-hardcoded the zh/Ender literals in primary-translator, stray-phrase-detector, glossary-manager, style-analyzer, stray-phrase-fixer, the orchestrator, and the skills (now labelled illustrative en→zh-TW examples); parameterized every deterministic check (stray-source, sentence/dialogue counts, register-marker gate, negation parity) by the profile with loud `SKIP`/`LOW_CONFIDENCE` degradation; added the zh-TW worked-example fixture under `docs/examples/en-zh-TW/`. Full (deferred) design in `docs/GENERALIZATION_DESIGN.md`. | Global | Make the pipeline work for arbitrary books AND arbitrary source→target pairs without losing the zh-TW quality |
| 2026-06-28 | Integrity + consistency hardening after an **empirical Flash-proxy run** (Ender's Game ch.7 en→zh-TW on `sonnet`-as-Flash, opus judge; see `docs/BENCHMARK_CH7_FLASHPROXY.md`). v1 leaked an English agent-reasoning line into the deliverable AND the Flash-class scorer PASSed it. Fixes: `OUTPUT DISCIPLINE` hard-contract on `primary-translator`/`final-translator`; `stray-phrase-detector` Leaked-Meta-Text/long-run-Latin gate + deterministic Name-Variant scan (runs on `final/` too); `translation-scorer` integrity preconditions (full-artifact read, FAIL on leakage/name-variance before craft rubric); `native-critique` mandatory Signature & Fidelity Pass; `glossary-manager` per-`proper_noun` `romanization`+`never_variants` lock; orchestrator global Name Lock in every scene's Glossary Reminder + new deterministic Step 4.4b Final-Artifact Integrity Gate; `ebook-packager` backstop extended to leakage/name-variance. | Global | A mid-tier run proved the worst defects (leaked source-language text, name romanization drift) are mechanical — carry consistency as DATA + deterministic gates, not as a bigger model or a prompt plea |
| 2026-06-28 | Gate robustness from a **haiku (weaker-than-Flash) stress run** (`docs/BENCHMARK_CH7_FLASHPROXY.md` follow-up): the gates failed *safe* (FAIL+HOLD on a too-weak workhorse) but two bugs surfaced. Fixed: (1) overlapping name-swap corruption — `glossary-manager` must not emit a `never_variants` form that is a substring of the canonical, and `stray-phrase-detector`/`-fixer` apply swaps longest-first/non-overlapping and skip any `Find` that is a substring of its `Replace` (prevents `敵方的門在下面`→`敵方的門在下面面`); (2) blind leak-regeneration loops — `stray-phrase-fixer` now **strips** leaked agent meta-text deterministically (Instruction 0) and orchestrator Step 4.4b strips-first, regenerates only on a resulting omission/persistent leak, else HOLD. | Global | Make the deterministic gates correct under a weak workhorse; never let a swap corrupt or a leak loop |
| 2026-06-28 | Collision-guard fix from the **two-model verification run** (haiku+sonnet): the prior swap-safety was insufficient — a glossary `never_variants` that is a single char / common word (e.g. `森`/forest listed as a wrong form of name Shen→`申`) blind-swapped 森林→申林 and regressed clean sonnet 8.0→4.5; a prefix-of-a-longer-token (`薩拉曼德軍` inside `薩拉曼德軍團`) produced `火蜥蜴軍團團`. Fixed: `glossary-manager` must NEVER list a single-char/common-word/sub-compound `never_variants` (set `[]` and rely on critique for one-hanzi names); `stray-phrase-detector`/`-fixer` only auto-swap a complete ≥2-char name token whose match isn't extended by a trailing hanzi, and route risky/short variants to `## Name Variant (review)` instead of an auto Repair Block. Verification meta-lesson: deterministic CJK name-swapping is unsafe for short/common variants, and "gates clean" ≠ "deliverable clean" (the JS leak scanner under-reported vs the opus judge). | Global | Prevent the name-swap from corrupting ordinary vocabulary; prefer flagging over blind swapping for CJK |
| 2026-06-28 | Re-verification of the collision-guard (opus: **improvement, safe to keep** — sonnet recovered 4.5→6.0, `森→申` gone, haiku doubling/split gone, haiku still HELD below floor) closed its two named gaps: (1) the `## Name Variant (review)` bucket was a routing dead-end → now consumed by `consistency-auditor`, which is additionally tasked to catch **model-invented** name variants (a name in >1 target form, e.g. Wiggin 魏金/威金/韋金, or raw source-script) that a `never_variants` list structurally cannot anticipate, and normalize to canonical; orchestrator Step 4.4b carries the bucket to the auditor + `native-critique`. (2) `stray-phrase-detector` leak scan now also flags editorial-annotation / markdown-header meta-text (e.g. `… → Add particle 啦`, `- Preserves granularity`) that is mostly target-script and slips the Latin scan. Standing lesson recorded: deterministic gates catch anticipated/mechanical defects; the LLM `consistency-auditor` is the necessary backstop for open-ended ones, and promotion gates on the judge/auditor, not the scanner alone. | Global | Make name-consistency robust to model-invented variants; close the review dead-end; harden meta-text detection |