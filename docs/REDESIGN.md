# Lexis Redesign — Authoritative Summary

**Goal:** make the lexis pipeline produce **high-quality literary translation with a mid-tier (Gemini Flash–class) model as the workhorse**, by improving *scaffolding* (decomposition, context engineering, external-signal verification, quality gates) rather than relying on a larger model.

This document is the authoritative description of the redesign. Companion docs:
- `docs/RESEARCH_SOTA.md` — verified state-of-the-art digest (human literary translation + LLM/MT), with sources.
- `docs/LOOP_LEDGER.md` — the 20-loop ideation → adversarial-critique → improvement record (what was accepted and, importantly, what was **rejected**).
- `docs/CONVERGED_BLUEPRINT.md` — the raw blueprint the loops produced (design rationale; the code + this file are authoritative where they differ).

---

## What changed (implemented)

1. **Explicit per-agent model-tier strategy (restored & documented).** The refactor that split the repo into two harnesses had dropped all per-agent `model:` pins. They are re-established in opencode frontmatter (`provider/model-id`). Antigravity has **no per-agent model slot** (`agent.json`/`settings.json` cannot express it) — runs on harness default; this asymmetry is documented in `antigravity/AGENTS.md` as an accepted divergence. See the tier table below.

2. **An external quality gate — the new `translation-scorer` agent (15th agent).** It emits a Markdown scorecard scoring **Adequacy / Fluency / Style Fidelity** (1–5, weighted overall) with a mandatory reasoning scratchpad and a trailing `SCORE_VERDICT:` sentinel (`PASS` / `MARGINAL` / `FAIL` / `ERROR`). Wired into the orchestrator at:
   - **Step 4.0** — score the first draft; a `FAIL` blocks silent continuation.
   - **Step 4.5** — score `final/` after critique application; an Adequacy drop ≥ 2 points vs the draft is flagged as a `critique-regression` (the finalizer may have lost content).
   - **Phase 5** — a per-chapter quality summary is presented before packaging; a `FAIL` blocks packaging without explicit user acceptance.
   This gives the mid-tier workhorse a *measured* acceptance signal instead of the previous count/string-only loop exits.

3. **Robust structured output for mid-tier models.** Flash-fragile JSON reports were migrated to Markdown with single, trailing, tolerantly-read sentinels:
   - `local-lexicographer`: `lexicon.json` → `lexicon.md`
   - `stray-phrase-detector`: `stray_report.json` → `stray_report.md` (`STATUS: CLEAN | ISSUES_FOUND | ERROR`)
   - `omission-detector`: hardened to a single trailing `STATUS:` sentinel
   - Downstream readers (`glossary-manager`, `stray-phrase-fixer`), the orchestrator, and the skills were all updated. The orchestrator reads the **last** `STATUS:`/`SCORE_VERDICT:` line, matches case-insensitively, and **fails safe** on a missing/malformed sentinel (never treats absence as success).
   - `master_glossary.json` intentionally **remains JSON** (it is a data store, not model prose).

4. **Special-content fidelity chain.** Footnotes, tables, verse/poetry, ruby/furigana, and image captions now get per-type translation strategies threaded end-to-end:
   - `narrative-summarizer` inventories them into a `## Special Content` section of `challenges.md` (with the strategy copied inline).
   - `primary-translator` applies each strategy (and has defaults for unlisted occurrences).
   - `native-critique` **exempts** their structural features (won't flag verse line breaks as "translationese," etc.).
   - `final-translator` carries a **hard constraint** that silently discards any critique suggestion that would collapse verse, merge table cells, drop footnote markers, or strip a ruby semantic gloss.

All four changes are applied to **both harnesses** and kept in semantic parity (antigravity `agent.json` ↔ opencode `.md`; both skill copies).

---

## Current model-tier map

| Tier | Model (opencode pin) | Agents |
| :--- | :--- | :--- |
| Pro | `google/gemini-3-pro-preview` | `primary-translator`, `final-translator`, `native-critique`, `metadata-generator` |
| Flash | `google/gemini-3-flash-preview` | `ebook-disbinder`, `ebook-packager`, `omission-detector`, `stray-phrase-detector`, `stray-phrase-fixer`, `translation-scorer` |
| Default (harness) | *(no pin)* | `toc-generator`, `style-analyzer`, `narrative-summarizer`, `local-lexicographer`, `glossary-manager` |

### The Flash-first decision (open knob)

The current baseline reproduces the repo's last deliberate human tier decision (`ba86672`), which keeps the four **literary-cognition** agents on **Pro**. The adversarial loops deliberately did **not** auto-demote them to Flash without evidence — that is the single highest-stakes change, and the scaffolding above (quality gate, special-content handling, robust sentinels, glossary scoping) exists precisely to make the demotion *safe and measurable*.

To run **Flash-as-workhorse end-to-end** (the project's north-star), flip those four pins to `google/gemini-3-flash-preview` and rely on the `translation-scorer` gate to catch failures, escalating only below-threshold chapters back to Pro. The recommended way to make that switch is behind a small quality benchmark (see Future Work) rather than blindly.

---

## What the adversarial critique *rejected* (do not re-propose without new evidence)

The loops rejected far more than they accepted (a healthy convergence signal). Recurring rejection reasons, captured so future contributors don't relitigate them — full detail in `docs/LOOP_LEDGER.md`:

- **In-pipeline structural chunking / token-budgeted segmentation** — rejected as currently unbuildable: the workhorse agents have `bash: deny` and there is **no tokenizer/parser/script actuator** in the repo, so a Flash LLM would have to do its own byte-exact block-walking and reassembly — exactly the unreliable work the design avoids. Admissible only once a committed deterministic chunker exists, or once whole-chapter overflow is *proven* on real fixtures.
- **Best-of-N candidate generation + scorer reranking** — rejected on actuator, scorer-noise, cost, and diversity grounds for now.
- **Several "Flash-shaped prompting" rewrites and a separate semantic-validator agent** — rejected as redundant with existing agents or as symptom-fixing in the wrong place.
- **Calling LLM-in-context work "deterministic"** — disallowed; without a script actuator, every "deterministic" step is really fallible LLM judgment and must be designed as such.

## Future work / open problems (see `docs/LOOP_LEDGER.md` for the full list)

- **Cross-chapter consistency auditor** (name/tone/register drift across the book) — accepted in the final loop but not implemented before the run ended; the highest-value next addition.
- **Deterministic chunking actuator** — a committed script the harness can call, which would unlock safe long-chapter segmentation and best-of-N.
- **Flash-migration benchmark** — a small fixture + scorer harness to decide, with evidence, whether the four literary agents can move to Flash.
- **Dynamic glossary feedback** (Stage B → glossary) and **per-chunk glossary scoping** (inject only terms present in the current segment).
- **Deterministic EPUB OPF/nav localization** (currently LLM-edited XML) + round-trip structural validation.
