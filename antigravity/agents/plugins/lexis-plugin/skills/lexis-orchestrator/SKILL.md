---
name: lexis-orchestrator
description: Coordinates the lexis book translation pipeline, managing 16 subagents sequentially through Stage A (extraction and glossary building chapter-by-chapter) and Stage B (translation draft, quality scoring, validation loops, critique, finalization chapter-by-chapter), a book-wide consistency audit, and packaging. Trigger this skill whenever you need to start, run, update, or check the status of the book translation pipeline.
---

# Lexis Translation Orchestrator

This skill coordinates the execution order, dependencies, and data flows of the 16 subagents in the `lexis` book translation pipeline.

## Execution Mode: Hybrid Sequential

To maintain narrative continuity and lexical integrity—and to prevent overwhelming context capacity—chapters must be processed **one at a time** within their respective stages:

1. **Stage A (Extraction & Glossary Building):** Process Chapter 1, then Chapter 2, etc., through the Extraction and Consolidation phases. This builds the `master_glossary.json` and summaries incrementally.
2. **Stage B (Production lifecycle):** Once **ALL** chapters complete Stage A, begin processing chapters one-by-one through the Production phase (Draft -> Validation -> Refinement -> Finalization). Do not start Stage B for Chapter N+1 until Chapter N is completely finalized.

---

## Subagents Map

| Subagent TypeName | Role / Phase | Primary Tool Group | Output Artifact |
| :--- | :--- | :--- | :--- |
| `ebook-disbinder` | Preparation | `run_command` | extracts EPUB to `original/` |
| `toc-generator` | Init (Global Context) | `view_file`, `write_to_file` | `notes/contents.json` |
| `style-analyzer` | Init (Global Context) | `view_file`, `write_to_file` | `notes/style_guide.md` |
| `metadata-generator` | Init (Global Context) | `view_file`, `write_to_file` | `notes/metadata.json` |
| `narrative-summarizer`| Extraction (Per-Chapter) | `view_file`, `write_to_file` | `notes/<name>.summary.txt`, `notes/<name>.challenges.md` |
| `local-lexicographer` | Extraction (Per-Chapter) | `view_file`, `write_to_file` | `notes/<name>.lexicon.md` |
| `glossary-manager` | Consolidation (Per-Chapter)| `view_file`, `write_to_file` | Updates `notes/master_glossary.json` |
| `primary-translator` | Production (Draft Stage) | `view_file`, `write_to_file` | `draft/<name>` |
| `translation-scorer` | Production (Draft + Finalization Stages) | `view_file`, `write_to_file` | `notes/<name>.score.md` (draft); `notes/<name>.final.score.md` (post-finalization) |
| `omission-detector` | Production (Draft Stage) | `view_file`, `write_to_file` | `notes/<name>.omission_report.md` |
| `stray-phrase-detector`| Production (Validation Stage)| `grep_search`, `run_command` | `notes/<name>.stray_report.md` |
| `stray-phrase-fixer` | Production (Validation Stage)| `view_file`, `write_to_file` | Updates `draft/<name>` |
| `native-critique` | Production (Refinement Stage)| `view_file`, `write_to_file` | `critique/<name>.critique.md` |
| `final-translator` | Production (Finalization) | `view_file`, `write_to_file` | `final/<name>` |
| `consistency-auditor` | Finalization (Book-Wide, once) | `view_file`, `grep_search`, `run_command` | `notes/consistency_report.md` |
| `ebook-packager` | Finalization Phase | `run_command` | `translated_book.epub` |

---

## Detailed Workflow

### Phase 0: Preparation (Ebook Disbinding)
- **Invocation**: Invoke `ebook-disbinder` to extract the source `.epub` file into `original/`.
- **Validation**: Confirm the existence of files and verify EPUB structural integrity.

### Phase 1: Global Context Initialization
These agents run once at the start of the project:
1. Invoke `toc-generator` to create `notes/contents.json` (reading order).
2. Invoke `style-analyzer` to create `notes/style_guide.md` (author's voice and style).
3. Invoke `metadata-generator` to create `notes/metadata.json` (source/target languages and contrastive guidance).

### Phase 2 & 3: Stage A - Per-Chapter Extraction & Consolidation Loop
Process each file in `notes/contents.json` **sequentially, one at a time**:
1. Invoke `narrative-summarizer` to output `notes/<filename>.summary.txt` and `notes/<filename>.challenges.md`.
2. Invoke `local-lexicographer` to output `notes/<filename>.lexicon.md`.
3. Invoke `glossary-manager` to read the lexicon and update `notes/master_glossary.json` incrementally.

*Once ALL files in the table of contents have completed Stage A, proceed to Stage B.*

### Phase 4: Stage B - Per-Chapter Production Lifecycle
Process each file **sequentially, one at a time**:

#### Step 4.0: Initial Quality Score
- After `primary-translator` produces the first draft (before entering the omission loop):
  1. Invoke `translation-scorer` to output `notes/<filename>.score.md`.
  2. Read the last `SCORE_VERDICT:` line from the scorecard (same tolerant reading rules as STATUS sentinels).
  3. Surface the Overall score and Critical Issues to the session log so the operator can see draft quality at a glance.
  4. On `SCORE_VERDICT: FAIL`: log the failure, surface the Critical Issues to the user, and request human guidance before proceeding to the omission loop. Do not silently continue past a FAIL verdict.
  5. On `SCORE_VERDICT: MARGINAL` or `SCORE_VERDICT: PASS`: proceed to the omission loop. The scorecard remains available on disk for downstream agents.
  6. If the scorecard has no recognizable `SCORE_VERDICT:` line or ends with `SCORE_VERDICT: ERROR`, treat it as `MARGINAL` (proceed with a warning), re-invoke `translation-scorer` once to confirm. Do not block on a malformed scorer output.

#### Step 4.1: Draft Loop (Alternating)
- Loop the following until `omission-detector` reports `STATUS: COMPLETE`:
  1. Invoke `primary-translator` to generate or update `draft/<filename>` (utilizing `master_glossary.json`, summaries, and any previous omission reports).
  2. Invoke `omission-detector` to output `notes/<filename>.omission_report.md`.

#### Step 4.2: Validation Loop (Alternating)
- Loop the following until `stray-phrase-detector` reports `STATUS: CLEAN`:
  1. Invoke `stray-phrase-detector` to output `notes/<filename>.stray_report.md`.
  2. If the status is not `STATUS: CLEAN`, invoke `stray-phrase-fixer` to update `draft/<filename>`.

#### Step 4.3: Refinement (Native Critique)
- Invoke `native-critique` to generate `critique/<filename>.critique.md`.

#### Step 4.4: Finalization
- Invoke `final-translator` to consolidate original text, the refined draft, and the native critique into `final/<filename>`.

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
- **Scorer sentinel reading**: The `translation-scorer` ends its scorecard with a `SCORE_VERDICT:` line. Read the **last** standalone `SCORE_VERDICT:` line in the file as canonical; ignore any earlier occurrences. Match case-insensitively; tolerate trivial whitespace variants. Valid values are `PASS`, `MARGINAL`, `FAIL`, and `ERROR`. A missing or unparseable verdict is treated as `MARGINAL` (proceed with warning), not as a hard failure — the scorer is a quality signal, not a loop gate.
- **Score extraction for delta computation**: To read Overall and Adequacy scores from a scorecard, look for the Markdown table row matching the dimension name (e.g., `| Adequacy |` or `| **Overall** |`). Extract the numeric value from the second column. If the table is malformed or the value is non-numeric, treat the score as unavailable and skip the delta computation; do not block on a missing delta. Log the unavailability as a `scorer-delta-unavailable` event.
- **Critique-regression semantics**: A Step 4.5 Adequacy drop of ≥ 2 points vs the Step 4.0 Adequacy score is a meaningful signal that the `final-translator`'s critique-application pass may have introduced content loss. It is NOT automatically a blocking failure — a human must decide. The threshold of 2 points is intentionally conservative (catching large drops only) given that the scorer is a stochastic Flash estimator; do not gate-halt on a 1-point drop.
- **Consistency-audit sentinel reading**: The `consistency-auditor` ends its report with a single authoritative `STATUS:` line (`CONSISTENT` / `ISSUES_FOUND` / `ERROR`). Read the **last** standalone `STATUS:` line as canonical (same tolerant matching as the detectors). A missing/malformed sentinel is treated as NOT consistent — re-invoke once, then request human guidance; never package on an unknown consistency status.

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
