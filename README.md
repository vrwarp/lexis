# lexis

A multi-stage sequential book-translation orchestration pipeline designed to produce **high-quality literary translation using a mid-tier (Gemini Flash–class) model as the workhorse**. Lexis disbinds an EPUB, builds a glossary chapter-by-chapter, drafts and validates translations, scores each chapter against an explicit quality gate, applies native critique, and packages a finished `translated_book.epub`. Quality comes from decomposition, context engineering, external-signal verification, and quality gates — scaffolding, not model size.

This repo ships **two runtime harnesses** that share the same 17 agents and 5 skills:

| Harness | Directory | Config | Agents | Skills |
| :--- | :--- | :--- | :--- | :--- |
| Google Antigravity | [`antigravity/`](./antigravity) | `settings.json`, `AGENTS.md` | `agents/plugins/lexis-plugin/agents/<name>/agent.json` (customAgent JSON) | `agents/plugins/lexis-plugin/skills/<name>/SKILL.md` |
| opencode | [`opencode/`](./opencode) | `opencode.json`, `AGENTS.md` | `.opencode/agents/<name>.md` (markdown frontmatter) | `.opencode/skills/<name>/SKILL.md` |

## Usage

- **Antigravity:** Copy the contents of `antigravity/` into your project root. Antigravity discovers the `lexis-plugin` plugin and its agents/skills automatically.
- **opencode:** Copy the contents of `opencode/` into your project root. opencode discovers agents under `.opencode/agents/` and skills under `.opencode/skills/`, and loads `opencode.json` + `AGENTS.md` as instructions.

## The 17 Subagents

`ebook-disbinder` · `toc-generator` · `metadata-generator` · `language-profiler` · `style-analyzer` · `narrative-summarizer` · `local-lexicographer` · `glossary-manager` · `primary-translator` · `translation-scorer` · `omission-detector` · `stray-phrase-detector` · `stray-phrase-fixer` · `native-critique` · `final-translator` · `consistency-auditor` · `ebook-packager`

## The 5 Skills

`lexis-orchestrator` (coordinates the pipeline) · `epub-handling` · `lexical-management` · `narrative-translation` · `translation-validation`

## Pipeline Overview

1. **Stage A** (per-chapter, sequential): summarize (+ inventory special content) → extract lexicon → consolidate master glossary.
2. **Stage B** (per-chapter, sequential): draft → **quality score** → omission loop → stray-phrase loop → native critique → finalize → **post-finalization regression gate**.
3. **Book-wide consistency audit** (runs once, before packaging): `consistency-auditor` checks terminology/honorific/register drift across all finalized chapters.
4. **Packaging:** present a per-chapter quality summary + consistency status, gate on them, then synchronize assets, localize metadata, and repackage into `translated_book.epub`.

## Design notes for mid-tier (Flash) quality

A real benchmark (an *Ender's Game* chapter, old Pro pipeline vs. Flash-everywhere) showed pure Flash regressing on literary dynamic equivalence, localized slang, domain terminology, register, and completeness. The levers below — refined through a 10× critique→ideation loop and detailed in [`docs/FLASH_QUALITY_PLAN.md`](./docs/FLASH_QUALITY_PLAN.md) — close that gap with scaffolding rather than a bigger model:

- **Exemplar prior (highest leverage).** A complete prior gold passage (`notes/TRANSLATION_EXEMPLARS.md`, operator-authored once) is embedded at the top of `style_guide.md`; every literary agent **continues** that voice rather than following an abstract rule — a mid-tier model is far more reliable at continuation than at rule-following.
- **Positive-Constraint Document.** `notes/POSITIVE_CONSTRAINTS.md` (operator-authored) locks correct target terms/forms (e.g. a futuristic "desk" → 電子桌, not the literal 課桌); `glossary-manager` treats it as authoritative.
- **Zero-generation repair.** The stray-phrase detector copies pre-authored replacement sentences into repair blocks and the fixer swaps them verbatim — no dynamic-equivalent generation in the repair path (the operation Flash fails).
- **Scene chunking + truncation guard.** Long chapters are translated scene-by-scene (boundaries resolved by grep), and a script-independent scan plus an `ebook-packager` integrity gate ensure a truncation placeholder can never reach the EPUB.
- **Language-pair-agnostic.** Language-specific behavior is **data, not hardcoded prompt text**: the `language-profiler` agent produces `notes/language_profile.md` (script relationship, sentence terminators, dialogue delimiters, register markers, negation markers, calque patterns, and the applicability/mode of each deterministic check). Every check reads the profile and **degrades loudly** where it doesn't apply (e.g. same-script pairs fall back from script-scan to stopword-scan or `skip_with_log`; the register-marker gate is skipped for languages without colloquial particles). zh-TW is a worked example under [`docs/examples/en-zh-TW/`](./docs/examples/en-zh-TW/), not the spec. The broader (deferred) generalization study is in [`docs/GENERALIZATION_DESIGN.md`](./docs/GENERALIZATION_DESIGN.md).
- **Model chosen at the harness level.** No agent pins a `model:` — every agent inherits whatever model the parent/harness/session is configured to use (both harnesses are symmetric). The pipeline is designed so a mid-tier (Flash-class) default reaches high quality via the scaffolding above; point the harness at a stronger model if you want one. See each `AGENTS.md`.
- **Book-wide consistency.** `consistency-auditor` runs once before packaging to catch cross-chapter terminology/honorific/register drift the per-chapter agents can't see.
- **Quality gate.** `translation-scorer` emits a markdown scorecard (Adequacy/Fluency/Style) ending in a `SCORE_VERDICT:` sentinel, used post-draft and as a post-finalization regression gate; a `FAIL` blocks silent progress and packaging. It first checks **integrity preconditions** (source-language leakage, proper-noun variance, unverifiable span) over the *whole* artifact — any one forces FAIL regardless of craft scores.
- **Deterministic integrity gates (don't trust a mid-tier model to police itself).** An empirical Flash-proxy run ([`docs/BENCHMARK_CH7_FLASHPROXY.md`](./docs/BENCHMARK_CH7_FLASHPROXY.md): *Ender's Game* ch.7 on `sonnet`-as-Flash, opus judge) showed a draft can leak an agent's own English reasoning line into the deliverable *and* the Flash-class scorer pass it. So the worst defects are caught mechanically, not by judgment: an `OUTPUT DISCIPLINE` contract on the translators, a **Leaked-Meta-Text / long-run-source scan** and a **Name-Variant scan** in `stray-phrase-detector` that also run on `final/` (orchestrator Step 4.4b), and a packaging backstop. Name consistency is carried as **data** — `glossary-manager` locks `romanization`+`never_variants` per proper noun and the orchestrator injects every name's locked form into every scene — because a per-scene mid-tier model told only "be consistent" re-coins a new spelling each scene.
- **Robust structured output.** Reports are Markdown with single trailing `STATUS:`/`SCORE_VERDICT:` sentinels read tolerantly (last line, case-insensitive, fail-safe on malformation) — JSON is reserved for `master_glossary.json` only, since forcing JSON degrades mid-tier prose.
- **Special-content fidelity.** Footnotes, tables, verse, ruby, and captions get per-type strategies threaded through summarizer → translator → critique → finalizer.

See `docs/` for the redesign blueprint, the SOTA research digest, and the full ideation/critique loop ledger. See the `lexis-orchestrator` skill for the full workflow, error-handling, and loop thresholds.