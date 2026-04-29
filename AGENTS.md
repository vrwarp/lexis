# Agent Orchestration Guide

This document outlines the execution order and responsibilities of the agents in the `lexis` translation pipeline.

## 1. Initialization Phase (Global Context)
These agents run once at the beginning of a project to establish the "map" and "voice" of the book.

1.  **TOC Generator (`toc-generator`)**: 
    - Scans the `original/` folder.
    - Creates `notes/contents.json` to define reading order and chapter titles.
2.  **Style Analyzer (`style-analyzer`)**: 
    - Samples representative chapters identified in the TOC.
    - Creates `notes/style_guide.md` to define the author's prose style and translation strategy.

## 2. Extraction Phase (Per-Section)
Run these agents for each individual file in the `original/` folder.

1.  **Narrative Summarizer (`narrative-summarizer`)**:
    - Analyzes the section for tone, character dynamics, and plot events.
    - Output: `notes/<filename>.summary.txt`.
2.  **Local Lexicographer (`local-lexicographer`)**:
    - Extracts proper nouns, idioms, and neologisms.
    - Output: `notes/<filename>.lexicon.json`.

## 3. Consolidation Phase (Per-Section)
This agent ensures terminology remains consistent across the entire project.

1.  **Glossary Manager (`glossary-manager`)**:
    - Merges the section's lexicon into the `notes/master_glossary.json`.
    - Updates usage notes and tracks which sections terms appear in.

## 4. Production Phase (Per-Section)
The final step in the pipeline.

1.  **Primary Translator (`primary-translator`)**:
    - Performs the actual translation using the raw text, the narrative summary, the style guide, and the master glossary.
    - Output: `translation/<filename>`.
