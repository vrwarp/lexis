# Agent Orchestration Guide

This document outlines the execution order, responsibilities, and dependencies of the agents in the `lexis` translation pipeline.

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

### 4.1. Draft Stage
1.  **Primary Translator (`primary-translator`)**
    - **Description**: Produces the initial high-fidelity draft.
    - **Dependencies**: 
        - **Global**: `master_glossary.json` (Final), `style_guide.md`, `metadata.json`, `contents.json`, and **all** `notes/*.summary.txt`.
        - **Local**: Corresponding file in `original/`.
    - **Output**: `draft/<filename>`.

### 4.2. Refinement Stage
1.  **Native Critique (`native-critique`)**
    - **Description**: Evaluates the draft for natural flow and audience alignment.
    - **Dependencies**: 
        - **Local**: `draft/<filename>`.
        - **Global**: `notes/metadata.json`.
    - **Output**: `critique/<filename>.critique.md`.

### 4.3. Finalization Stage
1.  **Final Translator (`final-translator`)**
    - **Description**: Consolidates the original, draft, and critique into the final version.
    - **Dependencies**: 
        - **Local**: `original/<filename>`, `draft/<filename>`, `critique/<filename>.critique.md`, and `notes/<filename>.summary.txt`.
        - **Global**: `master_glossary.json`, `style_guide.md`, `metadata.json`, `contents.json`.
    - **Output**: `final/<filename>`.
