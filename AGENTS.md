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
    - **Dependencies**: `toc-generator` (`notes/contents.json`).
    - **Output**: `notes/style_guide.md`.

## 2. Extraction Phase (Per-Section)
Run these agents for each individual file in the `original/` folder.

1.  **Narrative Summarizer (`narrative-summarizer`)**
    - **Description**: Extracts situational context and character dynamics.
    - **Dependencies**: `toc-generator` (`notes/contents.json`).
    - **Output**: `notes/<filename>.summary.txt`.
2.  **Local Lexicographer (`local-lexicographer`)**
    - **Description**: Extracts terms requiring consistency.
    - **Dependencies**: None.
    - **Output**: `notes/<filename>.lexicon.json`.

## 3. Consolidation Phase (Per-Section)
Must run after the Extraction Phase for a given section.

1.  **Glossary Manager (`glossary-manager`)**
    - **Description**: Updates the master glossary with new terms and usage notes.
    - **Dependencies**: `local-lexicographer` (`notes/<filename>.lexicon.json`).
    - **Output**: Updates `notes/master_glossary.json`.

## 4. Production Phase (Per-Section)
The final step, requiring all previous context to be ready.

1.  **Primary Translator (`primary-translator`)**
    - **Description**: Produces the final natural-language translation.
    - **Dependencies**: 
        - `narrative-summarizer` (`notes/<filename>.summary.txt`)
        - `glossary-manager` (`notes/master_glossary.json`)
        - `toc-generator` (`notes/contents.json`)
        - `style-analyzer` (`notes/style_guide.md`)
    - **Output**: `translation/<filename>`.
