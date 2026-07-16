# lexis

An EPUB translation pipeline that uses specialized subagents to extract, gloss, translate, validate, and package a book into a target language.

The pipeline exists in two harnesses:

| Harness | Location | Description |
|---|---|---|
| **Claude Agent SDK** | [`claude/`](claude/) | A web application built on `@anthropic-ai/claude-agent-sdk`. An orchestrator agent (interactive via a rich web UI) drives the 15 pipeline subagents. Opus handles the actual translation work; Sonnet handles everything else. Includes translation versioning with revert, a pre-packaging review gate, and optional custom-cover repackaging. |
| **smolagents** | [`smolagents/`](smolagents/) | The same pipeline, web UI, and harness contract ported to Hugging Face [smolagents](https://github.com/huggingface/smolagents) to diversify the models: every tier is a config entry that can point at any provider (Anthropic, OpenAI, Gemini, DeepSeek, HF Inference, local, …). Design and capability mapping in [`docs/SMOLAGENTS_ANALYSIS.md`](docs/SMOLAGENTS_ANALYSIS.md). |
| **open-agent** | [`openagent/`](openagent/) | The same pipeline on the framework substrate of [AFK-surf/open-agent](https://github.com/AFK-surf/open-agent) (Vercel AI SDK v5 + its copilot architecture: provider layer, named-prompt registry, nested-LLM-call tools, step-capped agent loop). Models per tier via `@ai-sdk/*` providers (Anthropic, OpenAI, Gemini, any OpenAI-compatible endpoint). Analysis in [`docs/OPENAGENT_ANALYSIS.md`](docs/OPENAGENT_ANALYSIS.md). |
| **opencode** | [`opencode/`](opencode/) | The original agent definitions and `translate-pipeline` skill for the opencode harness, preserved as-is. Run opencode with `opencode/` as the project root. |

All harnesses implement the same pipeline design. See [`docs/LESSONS.md`](docs/LESSONS.md) for the history of what was tried, reverted, and why — the current design is the last known good state.

## Pipeline overview

1. **Preparation** — extract the source EPUB (`ebook-disbinder`).
2. **Initialization** — reading order (`toc-generator`), language/audience parameters incl. register guidance and a translationese watchlist (`metadata-generator`), locale-aware author voice (`style-analyzer`), and a critique charter written in the target language (`critique-charter-generator`).
3. **Extraction + Consolidation (per chapter, sequential)** — summaries and linguistic challenges (`narrative-summarizer`), term extraction (`local-lexicographer`), master glossary updates (`glossary-manager`).
4. **Production (per chapter, sequential, only after all chapters finish stage 3)** — draft (`primary-translator`) ↔ omission audit (`omission-detector`) loop; stray source-language scan (`stray-phrase-detector`) ↔ fix (`stray-phrase-fixer`) loop; native critique (`native-critique`, charter-guided); final polish (`final-translator`); bounded final verification (`native-critique` verification mode → at most one more `final-translator` pass).
5. **Packaging (gated on user review)** — validate and zip a valid EPUB (`ebook-packager`).
