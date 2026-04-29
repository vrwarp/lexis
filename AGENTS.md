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

## 4. Production Phase (Final Global Step)
**CRITICAL**: This phase must only be initiated after **ALL** sections have successfully completed the Extraction and Consolidation phases. 

The Primary Translator relies on the global context established by the entire book. It is essential that:
- The `master_glossary.json` is fully finalized and includes all terms from every section.
- Every section has a corresponding `.summary.txt` available, allowing the translator to reference narrative arcs and continuity across the entire work.

1.  **Primary Translator (`primary-translator`)**
    - **Description**: Produces the final natural-language translation.
    - **Dependencies**: 
        - **All** section summaries (`notes/*.summary.txt`)
        - **Finalized** `notes/master_glossary.json`
        - `notes/contents.json`
        - `notes/style_guide.md`
        - `notes/metadata.json`
        - Corresponding file in `original/` folder.
    - **Output**: `translation/<filename>`.
