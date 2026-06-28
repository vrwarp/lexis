---
name: lexis-orchestrator
description: Coordinates the lexis book translation pipeline, managing 17 subagents sequentially through Init (incl. a per-language-pair profile), Stage A (extraction and glossary building chapter-by-chapter), Stage B (translation draft, quality scoring, validation loops, critique, finalization chapter-by-chapter), a book-wide consistency audit, and packaging. Trigger this skill whenever you need to start, run, update, or check the status of the book translation pipeline.
---

# Lexis Translation Orchestrator

This skill coordinates the execution order, dependencies, and data flows of the 17 subagents in the `lexis` book translation pipeline. The pipeline is language-pair-agnostic: language-specific behavior is driven by `notes/language_profile.md` (produced at Init), not hardcoded in agent prompts.

## Execution Mode: Hybrid Sequential

To maintain narrative continuity and lexical integrity—and to prevent overwhelming context capacity—chapters must be processed **one at a time** within their respective stages:

1. **Stage A (Extraction & Glossary Building):** Process Chapter 1, then Chapter 2, etc., through the Extraction and Consolidation phases. This builds the `master_glossary.json` and summaries incrementally.
2. **Stage B (Production lifecycle):** Once **ALL** chapters complete Stage A, begin processing chapters one-by-one through the Production phase (Draft -> Validation -> Refinement -> Finalization). Do not start Stage B for Chapter N+1 until Chapter N is completely finalized.

---

## Subagents Map

| Subagent (task `subagent_type`) | Role / Phase | Primary Tools | Output Artifact |
| :--- | :--- | :--- | :--- |
| `ebook-disbinder` | Preparation | `bash` | extracts EPUB to `original/` |
| `toc-generator` | Init (Global Context) | `read`, `write`, `glob` | `notes/contents.json` |
| `style-analyzer` | Init (Global Context) | `read`, `write`, `glob` | `notes/style_guide.md` |
| `metadata-generator` | Init (Global Context) | `read`, `write`, `glob` | `notes/metadata.json` |
| `language-profiler` | Init (Global Context) | `read`, `write`, `glob` | `notes/language_profile.md` (per-pair: script, terminators, dialogue delimiters, register markers, negation markers, calque patterns, per-check applicability) |
| `narrative-summarizer`| Extraction (Per-Chapter) | `read`, `write`, `glob` | `notes/<name>.summary.txt`, `notes/<name>.challenges.md`, `notes/<name>.scenes.md` |
| `local-lexicographer` | Extraction (Per-Chapter) | `read`, `write`, `glob` | `notes/<name>.lexicon.md` |
| `glossary-manager` | Consolidation (Per-Chapter)| `read`, `write`, `glob` | Updates `notes/master_glossary.json` |
| `primary-translator` | Production (Draft Stage) | `read`, `write`, `edit`, `glob` | `draft/<name>` |
| `translation-scorer` | Production (Draft + Finalization Stages) | `read`, `write`, `glob` | `notes/<name>.score.md` (draft); `notes/<name>.final.score.md` (post-finalization) |
| `omission-detector` | Production (Draft Stage) | `read`, `write`, `glob` | `notes/<name>.omission_report.md` |
| `stray-phrase-detector`| Production (Validation Stage)| `grep`, `bash`, `read` | `notes/<name>.stray_report.md` |
| `stray-phrase-fixer` | Production (Validation Stage)| `read`, `write`, `edit`, `glob` | Updates `draft/<name>` |
| `native-critique` | Production (Refinement Stage)| `read`, `write`, `glob` | `critique/<name>.critique.md` |
| `final-translator` | Production (Finalization) | `read`, `write`, `edit`, `glob` | `final/<name>` |
| `consistency-auditor` | Finalization (Book-Wide, once) | `read`, `grep`, `bash`, `glob` | `notes/consistency_report.md` |
| `ebook-packager` | Finalization Phase | `bash` | `translated_book.epub` |

---

## Subagent Dispatch

In opencode, each "Invoke `<agent>`" step below is performed with the `task` tool, passing `subagent_type: "<agent>"` and a detailed task prompt. Run subagents **strictly one at a time**; wait for each to finish before starting the next, so their outputs are available on disk for downstream agents to read.

## Detailed Workflow

### Phase 0: Preparation (Ebook Disbinding)
- **Invocation**: Invoke `ebook-disbinder` to extract the source `.epub` file into `original/`.
- **Validation**: Confirm the existence of files and verify EPUB structural integrity.

### Phase 1: Global Context Initialization
These agents run once at the start of the project:
1. Invoke `toc-generator` to create `notes/contents.json` (reading order).
2. Invoke `metadata-generator` to create `notes/metadata.json` (source/target languages and contrastive guidance).
3. Invoke `language-profiler` to create `notes/language_profile.md` — the per-language-pair profile (script relationship, sentence terminators, dialogue delimiters, register system + colloquial markers, negation markers, calque patterns, and the applicability/mode of each deterministic check). **Operator review gate:** surface the profile for confirmation before Stage B; the downstream checks obey it, so a wrong profile mis-configures them. Log `PROFILE_UNCONFIRMED` if the operator skips review.
4. Invoke `style-analyzer` to create `notes/style_guide.md` (author's voice and style; it reads the language profile and embeds the Register Exemplars).

### Phase 2 & 3: Stage A - Per-Chapter Extraction & Consolidation Loop
Process each file in `notes/contents.json` **sequentially, one at a time**:
1. Invoke `narrative-summarizer` to output `notes/<filename>.summary.txt`, `notes/<filename>.challenges.md`, and `notes/<filename>.scenes.md` (scene boundaries for safe chunking).
2. Invoke `local-lexicographer` to output `notes/<filename>.lexicon.md`.
3. Invoke `glossary-manager` to read the lexicon and update `notes/master_glossary.json` incrementally.

*Once ALL files in the table of contents have completed Stage A, proceed to Stage B.*

### Phase 3.5: Name Confirmation Gate (one-time, before Stage B)
Before any chapter enters Stage B, present the `proper_noun` entries (names, nicknames, callsigns) from `master_glossary.json` to the operator for one-time confirmation, and record the approved canonical forms in `notes/confirmed_names.md`. This is the cheapest fix for nickname/name mis-rendering (e.g. a derisive nickname translated literally instead of adapted). It is an operator gate, not a model step; if the operator skips it, proceed with the glossary forms and log `NAMES_UNCONFIRMED`.

### Phase 4: Stage B - Per-Chapter Production Lifecycle
Process each file **sequentially, one at a time**:

#### Step 4.0a: Scene Resolution & Initial Draft (chunked, anti-truncation)
Whole-chapter one-shot drafting causes a mid-tier model to truncate long chapters. Translate scene-by-scene instead:
1. **Resolve scenes [bash].** Read `notes/<filename>.scenes.md`. For each scene's `search_hints`, `grep -n` the hint words in `original/<filename>` to find that scene's start line; derive each scene's `[start_line, end_line)` range (a scene ends where the next begins; include the `Chapter Frame` as scene 0 if present). Write the verified ranges to `notes/<filename>.verified_scenes.json`.
   - If the chapter is short (single scene) or `scenes.md` lists one scene, treat the whole file as one scene — no chunking needed.
   - If a hint resolves to zero or multiple ambiguous locations, request a longer/more-distinctive description for that scene and retry. If still unresolved, write `STATUS: SCENE_BOUNDARY_UNRESOLVED`, surface it, and request guidance. **Never silently fall back to whole-chapter one-shot drafting** — that is the failure mode being prevented.
2. **Per-scene prep [bash, deterministic].** For each scene span, compute and stash (in `notes/<filename>.verified_scenes.json`) the inputs the translator needs inlined:
   - **Glossary Reminder** — `grep` the scene span for `master_glossary.json` source keys and collect the `{source → canonical target}` pairs that actually appear (so the translator gets only the relevant terms; illustrative en→zh-TW: 電子桌 / 發射生). **Plus a global Name Lock: ALWAYS append EVERY `proper_noun` entry's `{romanization → canonical target}` (and its `never_variants`), even names not detected in this scene.** Names are book-global, and a per-scene mid-tier model that is not handed the exact locked form WILL re-coin a different romanization (the dominant consistency failure — e.g. a transfer-slip rendering Bonzo as 波佐 while the body says 班佐). The translator must use these exact forms in prose, dialogue, AND any structured block (slips, signs, orders) in the span.
   - **Structure floor** — count sentence terminators and dialogue-opening lines in the span using the terminator/dialogue-delimiter classes from `notes/language_profile.md` (skip the dimensions the profile marks N/A, e.g. `sentence_count: paragraph_only`); record the minimums to preserve.
   - **Register** — read the scene's `register:` tag from `scenes.md`.
   (On antigravity, run these greps via `stray-phrase-detector`; the logic is identical.)
3. **Draft per scene.** For each verified scene in order, invoke `primary-translator` with that scene's source span, inlining immediately before the span (most-salient last): a `## FORBIDDEN CONSTRUCTIONS` block if `notes/calque_prohibitions.md` exists; the scene's `## Glossary Reminder`; the scene `register`; and the `MANDATORY STRUCTURE` floor (min sentence / dialogue-line counts). Append each returned translation to `draft/<filename>`. The translator must never emit a placeholder; if a scene comes back short, re-invoke it on that scene alone (cap 2).
4. The assembled `draft/<filename>` is the "first draft" consumed by Step 4.0. Optionally, run a reverse-seam grep at each scene join (a tense-marker density cliff, or a pronoun with no antecedent in the prior scene's tail) and record any hits in a non-canonical `notes/<filename>.seam_issues.md` (INFO only — it never blocks; full voice/register seam detection is not grep-reachable and stays a flagged review item).

On antigravity (where the orchestrator lacks `run_command`), route the grep/range-resolution steps through `stray-phrase-detector`, which holds `grep_search`/`run_command`; the logic is identical.

#### Step 4.0: Initial Quality Score
- After the chunked initial draft is assembled (before entering the omission loop):
  1. Invoke `translation-scorer` to output `notes/<filename>.score.md`.
  2. Read the last `SCORE_VERDICT:` line from the scorecard (same tolerant reading rules as STATUS sentinels).
  3. Surface the Overall score and Critical Issues to the session log so the operator can see draft quality at a glance.
  4. On `SCORE_VERDICT: FAIL`: log the failure, surface the Critical Issues to the user, and request human guidance before proceeding to the omission loop. Do not silently continue past a FAIL verdict.
  5. On `SCORE_VERDICT: MARGINAL` or `SCORE_VERDICT: PASS`: proceed to the omission loop. The scorecard remains available on disk for downstream agents.
  6. If the scorecard has no recognizable `SCORE_VERDICT:` line or ends with `SCORE_VERDICT: ERROR`, treat it as `MARGINAL` (proceed with a warning), re-invoke `translation-scorer` once to confirm. Do not block on a malformed scorer output.

#### Step 4.1: Draft Loop (Alternating, scene-scoped)
- Loop the following until `omission-detector` reports `STATUS: COMPLETE` (max 3 iterations):
  1. Invoke `omission-detector` to output `notes/<filename>.omission_report.md` (it tags each omission with a `**Scene:**` id from `verified_scenes.json`).
  2. For each omission, re-invoke `primary-translator` on **only the affected scene's source span** (per the omission's Scene tag + `verified_scenes.json`), passing the omission report, and re-assemble `draft/<filename>`. Do NOT re-translate the whole chapter (that re-opens the truncation risk scene-chunking closed). If `verified_scenes.json` is absent, fall back to a whole-file refinement pass and log a warning.

#### Step 4.2: Validation Loop (Alternating)
- Loop the following until `stray-phrase-detector` reports `STATUS: CLEAN` (max 3 iterations):
  1. Invoke `stray-phrase-detector` to output `notes/<filename>.stray_report.md`.
  2. On `STATUS: TRUNCATION_ARTIFACT` (a placeholder/truncation was found — the draft is incomplete): identify the affected scene from the reported line numbers, re-invoke `primary-translator` on that scene's verified source span (per Step 4.0a), re-assemble `draft/<filename>`, and re-run the detector. Cap at 2 truncation retries per chapter; if still truncated, surface it and request guidance — never advance a chapter whose draft contains a placeholder.
  3. On `STATUS: ISSUES_FOUND`: invoke `stray-phrase-fixer`, which applies any `## Repair Block` entries as literal swaps (PCD canonical-term and de-calque fixes) and translates the remaining stray phrases, updating `draft/<filename>`.
  4. On `STATUS: ERROR` or a malformed/missing sentinel: apply the malformation fail-safe — do not treat as CLEAN; re-invoke once; then request guidance.
- **Structure-deficit advisory:** Independently of the `STATUS:` sentinel, if the stray report contains a `## Structure Deficit`, `## Paragraph Elision`, or `## Negation Deficit` section, the draft likely over-compressed or dropped a negation. Surface these to the operator and carry them into the native-critique step (which must not suggest further merges and will scrutinize the flagged negation paragraph); they are advisory and do not block the loop.

#### Step 4.2b: Particle Retranslation (register gate — externally-triggered, gated, cap 1)
- If the stray report flagged `## Particle Absent` for any `DIALOGUE`/`INTERIORITY` scene (the register likely came out flat/formal):
  1. Back up the current `draft/<filename>` to `notes/<filename>.draft_backup`.
  2. Re-invoke `primary-translator` on that scene's span with the register-matched exemplar, the `## Failure Mode Anti-Patterns`, the scene `## Glossary Reminder`, and an explicit instruction to use the target language's colloquial register markers (from `notes/language_profile.md`) in dialogue/interiority; re-assemble. *(This whole step runs only when the profile's `register_marker_gate` is `apply`; languages without colloquial markers never reach it.)*
  3. Re-run the register-marker grep. **Accept** the retranslation only if markers are now present AND no new truncation/stray issue appeared; **otherwise REVERT** to the backup. Cap: 1 retry per scene.
- This is the only added conditional Stage-B model call. It is externally triggered (a deterministic grep, not Flash self-judgment), gated (accept-only-if-improved), and reverts on failure — categorically distinct from a self-critique loop.

#### Step 4.3: Refinement (Native Critique)
- Invoke `native-critique` to generate `critique/<filename>.critique.md`.

#### Step 4.4: Finalization
- Invoke `final-translator` to consolidate original text, the refined draft, and the native critique into `final/<filename>`.

#### Step 4.4b: Final-Artifact Integrity Gate (deterministic, runs ON `final/`, BEFORE scoring)
The `final-translator` (and any critique-application pass) can RE-INTRODUCE integrity defects the draft-stage checks never re-examine — most dangerously a leaked agent reasoning line ("Let me now produce the final translation…") or a re-coined name in a structured block. These are mechanical and must not depend on an LLM verdict. After `final/<filename>` is written:
1. Invoke `stray-phrase-detector` **on `final/<filename>`** (it runs Task 0b Leaked-Meta-Text / Long-Run-Source scan and Task 11 Name-Variant scan identically on the final).
2. On a `## Leaked Meta-Text` hit (`LEAK — REGENERATE`): this is a hard failure, but **strip first, regenerate second** — on a weak workhorse, blindly re-asking the model just produces a fresh leak (observed: a too-weak model leaked on every retry). So: (a) invoke `stray-phrase-fixer` to **deterministically delete** the flagged leaked lines, then re-run this gate; (b) only if the strip leaves an *omission* (a real source sentence now untranslated, caught by re-running `omission-detector` on the affected scene) OR the leak persists do you **re-run that scene's `final-translator`/`primary-translator` on its verified span**. Cap 2 regenerations per chapter. Never advance/package a final still containing source-language reasoning text — if it still leaks after the strip + 2 regenerations, surface and HOLD (do not ship).
3. On a `## Name Variant` or `## Glossary Conflict` hit: invoke `stray-phrase-fixer` to apply the Repair Blocks (literal `variant → canonical` swaps, including inside transfer-slip/sign blocks), re-assemble, and re-run this gate.
4. Only once this gate is clean does the chapter proceed to Step 4.5. (`ebook-packager` re-runs the same leak/variant/truncation scan at packaging as the final backstop.)

#### Step 4.5: Post-Finalization Quality Score (Regression Gate)
- After `final-translator` writes `final/<filename>` and **before** advancing to the next chapter:
  1. Invoke `translation-scorer` with the instruction to evaluate `final/<filename>` and write its scorecard to `notes/<filename>.final.score.md`.
  2. Read the last `SCORE_VERDICT:` line from `notes/<filename>.final.score.md` using the same tolerant reading rules as Step 4.0.
  3. Read the Overall score from both `notes/<filename>.score.md` (draft) and `notes/<filename>.final.score.md` (final). Log the delta to the session (positive delta = improvement, negative delta = regression).
  4. Read the Adequacy score from both scorecards and compute the Adequacy delta.
  5. **Regression check:** If the final Adequacy score is **2 or more points lower** than the draft Adequacy score, this is a significant regression — the critique application may have introduced content loss. Log the regression as a `critique-regression` event, surface both scorecards' Critical Issues to the user, and request human guidance before proceeding to the next chapter. Do not silently advance past an Adequacy regression of this magnitude.
  6. **Final FAIL check:** If `SCORE_VERDICT: FAIL` on the final scorecard (regardless of drift direction), surface the Critical Issues and request human guidance before proceeding.
  7. On `SCORE_VERDICT: PASS` or `MARGINAL` with no large Adequacy regression: log the verdict and delta, then proceed to the next chapter.
  8. If the scorecard has no recognizable `SCORE_VERDICT:` line or ends with `SCORE_VERDICT: ERROR`, treat as `MARGINAL` with a warning and re-invoke `translation-scorer` once (same malformation rules as Step 4.0).

*Once Chapter N has completed Step 4.5 without a blocking event, proceed to Chapter N+1.*

### Phase 4.6: Cross-Chapter Consistency Audit (Book-Wide, runs once)
After **ALL** chapters have completed Step 4.5 and exist in `final/`, and **before** packaging:
1. Invoke `consistency-auditor` once to audit the whole finalized book and write `notes/consistency_report.md`.
2. Read the **last** standalone `STATUS:` line from the report using the same tolerant rules as the detectors. Valid values: `STATUS: CONSISTENT`, `STATUS: ISSUES_FOUND`, `STATUS: ERROR`.
3. On `STATUS: CONSISTENT`: log it and proceed to Phase 5.
4. On `STATUS: ISSUES_FOUND`: surface the issue list (terminology / honorific / register deviations) to the user. For **terminology** deviations against a `proper_noun`/`neologism` canonical translation, you may invoke `stray-phrase-fixer` on the affected `final/<file>` with a targeted instruction to correct the specific term to its glossary-canonical form (then re-run the affected chapter's Step 4.5 score). For honorific/register issues, request human guidance. Do not silently package a book with unresolved terminology inconsistencies.
5. On `STATUS: ERROR` or a missing/malformed sentinel: re-invoke `consistency-auditor` once; if still unparseable, surface it as a `consistency-audit-malformation` event and request human guidance rather than skipping the audit.

### Phase 5: Finalization & Packaging
1. Present a complete project summary to the user (file completion status, localized metadata metrics, and the consistency-audit result).
2. **Pre-packaging quality gate:** Before asking for packaging approval, read the final scorecard (`notes/<filename>.final.score.md`) for every chapter that completed Stage B and the `notes/consistency_report.md`. For each chapter, extract the `SCORE_VERDICT:` and Overall score. Present this quality summary table (plus the consistency-audit status) to the user. If any chapter has `SCORE_VERDICT: FAIL` in its final scorecard, or the consistency audit is `STATUS: ISSUES_FOUND` with unresolved terminology deviations, surface the details and **do not proceed to packaging** until the user explicitly acknowledges and accepts the risk, or requests a remediation pass.
3. **Explicit User Confirmation**: Ask the user for explicit permission to package. The permission request must include the quality summary table so the user is making an informed decision.
4. Upon approval, invoke `ebook-packager` to synchronize assets, update localized metadata tags, and zip/package `final/` folder into `translated_book.epub`.

---

## Error Handling

- **Subagent failure**: Retry the invocation once. If it fails a second time, log the failure, notify the user, and request instructions.
- **Loop threshold**: Limit both the Omission Loop and the Validation Loop to a maximum of 3 iterations per chapter. If loops exceed 3, pause and request human intervention.
- **Status sentinel reading**: The Flash detectors (`omission-detector`, `stray-phrase-detector`) end their report with a single authoritative `STATUS:` line. Read the **last** standalone `STATUS:` line in the report as canonical; ignore any earlier occurrences (they are reasoning artifacts). Match it case-insensitively and tolerate trivial variants (extra whitespace, missing space after the colon). A loop-exit pass requires an explicit positive sentinel: `STATUS: COMPLETE` for the Omission Loop, `STATUS: CLEAN` for the Validation Loop.
- **Malformation fallback (fail-safe)**: If a detector's report has NO recognizable `STATUS:` line, or ends with `STATUS: ERROR`, or the sentinel is otherwise unparseable, treat the gate as **NOT passed** — never interpret a missing or malformed sentinel as a pass. Re-invoke that detector once (counts against the loop threshold). If the sentinel is still malformed on the retry, do not silently exit the gate: surface it as a `detector-malformation` event, log it, and request human guidance rather than packaging a chapter whose validation status is unknown.
- **Scorer sentinel reading**: The `translation-scorer` ends its scorecard with a `SCORE_VERDICT:` line. Read the **last** standalone `SCORE_VERDICT:` line in the file as canonical; ignore any earlier occurrences. Match case-insensitively; tolerate trivial whitespace variants. Valid values are `PASS`, `MARGINAL`, `FAIL`, and `ERROR`. A missing or unparseable verdict is treated as `MARGINAL` (non-blocking) with a warning, not as a hard failure — the scorer is a quality signal, not a loop gate.
- **Score extraction for delta computation**: To read Overall and Adequacy scores from a scorecard, look for the Markdown table row matching the dimension name (e.g., `| Adequacy |` or `| **Overall** |`). Extract the numeric value from the second column. If the table is malformed or the value is non-numeric, treat the score as unavailable and skip the delta computation; do not block on a missing delta. Log the unavailability as a `scorer-delta-unavailable` event.
- **Critique-regression semantics**: A Step 4.5 Adequacy drop of ≥ 2 points vs the Step 4.0 Adequacy score is a meaningful signal that the `final-translator`'s critique-application pass may have introduced content loss. It is NOT automatically a blocking failure — a human must decide. The threshold of 2 points is intentionally conservative (catching large drops only) given that the scorer is a stochastic Flash estimator; do not gate-halt on a 1-point drop.
- **Consistency-audit sentinel reading**: The `consistency-auditor` ends its report with a single authoritative `STATUS:` line (`CONSISTENT` / `ISSUES_FOUND` / `ERROR`). Read the **last** standalone `STATUS:` line as canonical (same tolerant matching as the detectors). A missing/malformed sentinel is treated as NOT consistent — re-invoke once, then request human guidance; never package on an unknown consistency status.
- **Truncation handling (hard failure)**: `STATUS: TRUNCATION_ARTIFACT` from `stray-phrase-detector` means a placeholder/incomplete passage reached the draft. Never treat it as CLEAN or as a normal stray issue: re-translate the affected scene (Step 4.0a span), cap 2 retries, then escalate. `ebook-packager` independently re-checks `final/` for truncation artifacts and PCD canonical violations and **aborts packaging** on any hit — a placeholder must never ship.
- **Scene resolution**: `STATUS: SCENE_BOUNDARY_UNRESOLVED` means scene hints could not be located in the source. Request a more distinctive description and retry; never silently fall back to whole-chapter one-shot drafting (the truncation cause).

## Test Scenarios

### Happy Path
1. Place `source.epub` in root.
2. Orchestrator triggers, invokes `ebook-disbinder` -> extracts files.
3. Init runs -> creates TOC, Style Guide, Metadata.
4. Stage A loop runs chapter-by-chapter, building master glossary.
5. Stage B loop runs chapter-by-chapter, producing, scoring, and validating translations.
6. Book-wide consistency audit runs once -> `STATUS: CONSISTENT`.
7. Packaging runs upon user approval -> `translated_book.epub` generated successfully.

### Loop Timeout Path
1. Primary draft omission check fails persistently.
2. Loop reaches iteration count of 3.
3. Orchestrator stops loop, outputs draft status, and asks the user for guidance.
