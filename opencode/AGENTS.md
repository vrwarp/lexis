# lexis

An EPUB translation pipeline that uses specialized subagents to extract, gloss, translate, validate, and package a book into a target language.

## Pipeline

To run a translation, load the `translate-pipeline` skill. It defines the full phase order, per-chapter sequencing rules, agent dependencies, and the packaging confirmation gate.

## Directory Structure

- `original/` — Extracted source EPUB contents (input).
- `notes/` — Global context built incrementally: `contents.json`, `style_guide.md`, `metadata.json`, `master_glossary.json`, plus per-section summaries, challenges, lexicons, and reports.
- `draft/` — Working translations produced by the Primary Translator.
- `critique/` — Native-critique feedback per section.
- `final/` — Finalized translations ready for packaging.

## Subagents

All 15 agents are defined in `.opencode/agents/` and invoked as subagents via the Task tool. The `translate-pipeline` skill documents when to call each one.

| Tier | Model | Agents |
|---|---|---|
| Pro | `opencode-go/glm-5.2` | `primary-translator`, `final-translator`, `metadata-generator`, `native-critique`, `critique-charter-generator`, `style-analyzer` |
| Flash | `opencode-go/mimo-v2.5` | `ebook-disbinder`, `ebook-packager`, `glossary-manager`, `local-lexicographer`, `narrative-summarizer`, `omission-detector`, `stray-phrase-detector`, `stray-phrase-fixer`, `toc-generator` |
