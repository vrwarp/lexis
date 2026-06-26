---
name: lexis-orchestrator
description: Coordinates the lexis book translation pipeline, managing 14 subagents sequentially through Stage A (extraction and glossary building chapter-by-chapter) and Stage B (translation draft, validation loops, critique, finalization chapter-by-chapter), and packaging. Trigger this skill whenever you need to start, run, update, or check the status of the book translation pipeline.
---

# Lexis Translation Orchestrator

This skill coordinates the execution order, dependencies, and data flows of the 14 subagents in the `lexis` book translation pipeline.

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
| `omission-detector` | Production (Draft Stage) | `view_file`, `write_to_file` | `notes/<name>.omission_report.md` |
| `stray-phrase-detector`| Production (Validation Stage)| `grep_search`, `run_command` | `notes/<name>.stray_report.md` |
| `stray-phrase-fixer` | Production (Validation Stage)| `view_file`, `write_to_file` | Updates `draft/<name>` |
| `native-critique` | Production (Refinement Stage)| `view_file`, `write_to_file` | `critique/<name>.critique.md` |
| `final-translator` | Production (Finalization) | `view_file`, `write_to_file` | `final/<name>` |
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

*Once Chapter N has completed Step 4.4, proceed to Chapter N+1.*

### Phase 5: Finalization & Packaging
1. Present a complete project summary to the user (file completion status, localized metadata metrics).
2. **Explicit User Confirmation**: Ask the user for explicit permission to package.
3. Upon approval, invoke `ebook-packager` to synchronize assets, update localized metadata tags, and zip/package `final/` folder into `translated_book.epub`.

---

## Error Handling

- **Subagent failure**: Retry the invocation once. If it fails a second time, log the failure, notify the user, and request instructions.
- **Loop threshold**: Limit both the Omission Loop and the Validation Loop to a maximum of 3 iterations per chapter. If loops exceed 3, pause and request human intervention.
- **Status sentinel reading**: The Flash detectors (`omission-detector`, `stray-phrase-detector`) end their report with a single authoritative `STATUS:` line. Read the **last** standalone `STATUS:` line in the report as canonical; ignore any earlier occurrences (they are reasoning artifacts). Match it case-insensitively and tolerate trivial variants (extra whitespace, missing space after the colon). A loop-exit pass requires an explicit positive sentinel: `STATUS: COMPLETE` for the Omission Loop, `STATUS: CLEAN` for the Validation Loop.
- **Malformation fallback (fail-safe)**: If a detector's report has NO recognizable `STATUS:` line, or ends with `STATUS: ERROR`, or the sentinel is otherwise unparseable, treat the gate as **NOT passed** — never interpret a missing or malformed sentinel as a pass. Re-invoke that detector once (counts against the loop threshold). If the sentinel is still malformed on the retry, do not silently exit the gate: surface it as a `detector-malformation` event, log it, and request human guidance rather than packaging a chapter whose validation status is unknown.

## Test Scenarios

### Happy Path
1. Place `source.epub` in root.
2. Orchestrator triggers, invokes `ebook-disbinder` -> extracts files.
3. Init runs -> creates TOC, Style Guide, Metadata.
4. Stage A loop runs chapter-by-chapter, building master glossary.
5. Stage B loop runs chapter-by-chapter, producing and validating translations.
6. Packaging runs upon user approval -> `translated_book.epub` generated successfully.

### Loop Timeout Path
1. Primary draft omission check fails persistently.
2. Loop reaches iteration count of 3.
3. Orchestrator stops loop, outputs draft status, and asks the user for guidance.
