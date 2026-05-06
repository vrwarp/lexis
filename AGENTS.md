# Agent Orchestration Guide

This document outlines the execution order, responsibilities, and dependencies of the agents in the `lexis` translation pipeline.

## Core Mandate: Sequential Processing
**DO NOT BATCH CHAPTERS.** To maintain narrative continuity and lexical integrity—and to **prevent overwhelming the subagents' context and processing capacity**—chapters must be processed **one at a time** within their respective stages:

1.  **Stage A (Phases 2 & 3):** Process Chapter 1, then Chapter 2, and so on through the Extraction and Consolidation phases. This builds the `master_glossary.json` and narrative summaries incrementally.
2.  **Stage B (Phase 4):** Once **ALL** chapters have completed Stage A, begin processing chapters one-by-one through the Production Phase (Draft -> Validation -> Refinement -> Finalization). This allows each translation to reference the specific finalized context of the preceding chapters.

Do not initiate Phase 4 for any chapter until the global context is fully established. Do not initiate Phase 4 for Chapter N+1 until Chapter N has completed its entire Production lifecycle.

## 0. Preparation Phase
1.  **Ebook Disbinder (`ebook-disbinder`)**
    - **Description**: Extracts the source `.epub` into the `original/` folder and verifies structure.
    - **Output**: Populated `original/` directory.

## 1. Initialization Phase (Global Context)
These agents run once at the beginning of a project.

1.  **TOC Generator (`toc-generator`)**
    - **Description**: Scans `original/` to establish reading order.
    - **Dependencies**: None.
    - **Output**: `notes/contents.json`.
2.  **Style Analyzer (`style-analyzer`)**
    - **Description**: Defines the author's voice and translation strategy.
    - **Dependencies**: 
        - `toc-generator` (`notes/contents.json`)
        - **Sampled sections** from the `original/` folder.
    - **Output**: `notes/style_guide.md`.
3.  **Metadata Generator (`metadata-generator`)**
    - **Description**: Identifies source/target languages and audience profiles.
    - **Dependencies**: 
        - `toc-generator` (`notes/contents.json`)
        - **Sampled sections** from the `original/` folder.
    - **Output**: `notes/metadata.json`.

## 2. Extraction Phase (Per-Section)
Run these agents for each individual file in the `original/` folder.

1.  **Narrative Summarizer (`narrative-summarizer`)**
    - **Description**: Extracts situational context and character dynamics.
    - **Dependencies**: 
        - `toc-generator` (`notes/contents.json`)
        - Corresponding file in `original/` folder.
    - **Output**: `notes/<filename>.summary.txt`.
2.  **Local Lexicographer (`local-lexicographer`)**
    - **Description**: Extracts terms requiring consistency.
    - **Dependencies**: Corresponding file in `original/` folder.
    - **Output**: `notes/<filename>.lexicon.json`.

## 3. Consolidation Phase (Per-Section)
Must run after the Extraction Phase for a given section.

1.  **Glossary Manager (`glossary-manager`)**
    - **Description**: Updates the master glossary with new terms and usage notes.
    - **Dependencies**: 
        - `local-lexicographer` (`notes/<original file>.lexicon.json`)
        - `metadata-generator` (`notes/metadata.json`)
        - Corresponding file in `original/` folder.
    - **Output**: Updates `notes/master_glossary.json`.

## 4. Production Phase (Multi-Stage Refinement)
**CRITICAL**: This phase must only be initiated after **ALL** sections have successfully completed the Extraction and Consolidation phases (1, 2, and 3). This ensures the `master_glossary.json` and all narrative summaries are fully finalized.

### 4.1. Draft Stage (Iterative Loop)
**NOTE**: Steps 1 and 2 should alternate until the `omission-detector` reports `STATUS: COMPLETE`.

1.  **Primary Translator (`primary-translator`)**
    - **Description**: Produces or refines the initial high-fidelity draft.
    - **Dependencies**: 
        - **Global**: `master_glossary.json` (Final), `style_guide.md`, `metadata.json`, `contents.json`, and **all** `notes/*.summary.txt`.
        - **Local**: `original/<filename>`, and optionally `notes/<filename>.omission_report.md`.
    - **Output**: `draft/<filename>`.

2.  **Omission Detector (`omission-detector`)**
    - **Description**: Meticulously audits the draft against the original to identify skipped content.
    - **Dependencies**: `original/<filename>`, `draft/<filename>`.
    - **Output**: `notes/<filename>.omission_report.md`.

### 4.2. Validation Stage (Iterative Loop)
**NOTE**: The agents in this stage should alternate until the `stray-phrase-detector` reports a `"status": "CLEAN"`.

1.  **Stray Phrase Detector (`stray-phrase-detector`)**
    - **Description**: Scans the draft for accidental source-language phrases. Uses regex optimizations for script-mismatch projects.
    - **Dependencies**: 
        - **Local**: `draft/<filename>`.
        - **Global**: `notes/metadata.json`.
    - **Output**: `notes/<filename>.stray_report.json`.

2.  **Stray Phrase Fixer (`stray-phrase-fixer`)**
    - **Description**: Translates identified stray phrases to ensure 100% coverage.
    - **Dependencies**: 
        - **Local**: `original/<filename>`, `draft/<filename>`, `notes/<filename>.stray_report.json`, and `notes/<filename>.summary.txt`.
        - **Global**: `master_glossary.json`, `style_guide.md`, `metadata.json`, `contents.json`.
    - **Output**: Updates `draft/<filename>`.

### 4.3. Refinement Stage
1.  **Native Critique (`native-critique`)**
    - **Description**: Evaluates the cleaned draft for natural flow and audience alignment.
    - **Dependencies**: 
        - **Local**: `draft/<filename>` (Post-Validation).
        - **Global**: `notes/metadata.json`.
    - **Output**: `critique/<filename>.critique.md`.

### 4.4. Finalization Stage
1.  **Final Translator (`final-translator`)**
    - **Description**: Consolidates the original, validated draft, and critique into the final version.
    - **Dependencies**: 
        - **Local**: `original/<filename>`, `draft/<filename>`, `critique/<filename>.critique.md`, and `notes/<filename>.summary.txt`.
        - **Global**: `master_glossary.json`, `style_guide.md`, `metadata.json`, `contents.json`.
    - **Output**: `final/<filename>`.

## 5. Finalization Phase (Packaging)
**MANDATORY**: Before executing the `ebook-packager`, the orchestrator MUST present a summary of the project (e.g., file completion status, localized metadata) to the user and obtain explicit confirmation to proceed.

1.  **Ebook Packager (`ebook-packager`)**
    - **Description**: Synchronizes assets, localizes structural metadata, and packages the `final/` folder into a valid `.epub`.
    - **Dependencies**: 
        - **Global**: `master_glossary.json`, `contents.json`, `metadata.json`.
        - **Local**: All files in `original/` and `final/`.
    - **Output**: `translated_book.epub`.
