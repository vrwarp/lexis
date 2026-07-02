# lexis

An EPUB translation pipeline that uses specialized subagents to extract, gloss, translate, validate, and package a book into a target language.

The pipeline exists in two harnesses:

| Harness | Location | Description |
|---|---|---|
| **Claude Agent SDK** | [`claude/`](claude/) | A web application built on `@anthropic-ai/claude-agent-sdk`. An orchestrator agent (interactive via a rich web UI) drives the 14 pipeline subagents. Opus handles the actual translation work; Sonnet handles everything else. Includes translation versioning with revert, a pre-packaging review gate, and optional custom-cover repackaging. |
| **opencode** | [`opencode/`](opencode/) | The original agent definitions and `translate-pipeline` skill for the opencode harness, preserved as-is. Run opencode with `opencode/` as the project root. |

Both harnesses implement the same pipeline design. See [`docs/LESSONS.md`](docs/LESSONS.md) for the history of what was tried, reverted, and why — the current design is the last known good state.

## Pipeline overview

1. **Preparation** — extract the source EPUB (`ebook-disbinder`).
2. **Initialization** — reading order (`toc-generator`), author voice (`style-analyzer`), language/audience parameters (`metadata-generator`).
3. **Extraction + Consolidation (per chapter, sequential)** — summaries and linguistic challenges (`narrative-summarizer`), term extraction (`local-lexicographer`), master glossary updates (`glossary-manager`).
4. **Production (per chapter, sequential, only after all chapters finish stage 3)** — draft (`primary-translator`) ↔ omission audit (`omission-detector`) loop; stray source-language scan (`stray-phrase-detector`) ↔ fix (`stray-phrase-fixer`) loop; native critique (`native-critique`); final polish (`final-translator`).
5. **Packaging (gated on user review)** — validate and zip a valid EPUB (`ebook-packager`).
