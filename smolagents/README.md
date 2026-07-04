# lexis — smolagents harness

The lexis EPUB translation pipeline running on
[smolagents](https://github.com/huggingface/smolagents), built to **diversify the models**
behind the pipeline: the design is identical to the Claude Agent SDK harness
([`../claude/`](../claude/)) — same 14 subagents, same prompts, same sequencing, review
gate, versioning, and web UI — but every model slot is a config entry that can point at
any provider (Anthropic, OpenAI, Gemini, DeepSeek, Mistral, HF Inference, OpenRouter,
local vLLM/Ollama, …).

The full design rationale and the Claude-SDK → smolagents capability mapping live in
[`../docs/SMOLAGENTS_ANALYSIS.md`](../docs/SMOLAGENTS_ANALYSIS.md). The pipeline's design
invariants are in [`../docs/LESSONS.md`](../docs/LESSONS.md) — in particular: keep a
strong model on the `translation` tier.

## Architecture (one paragraph)

A FastAPI server exposes the same endpoints/WS protocol and web UI as the Claude harness.
Each project gets a long-lived orchestrator session: a smolagents `ToolCallingAgent`
running on its own thread, continuing one conversation across user messages
(`run(reset=False)` + persisted memory). The 14 pipeline agents are **managed agents**
(fresh memory per invocation — the analogue of the SDK's `Task` tool), each with
workspace-rooted file tools (`read_file`, `write_file`, `edit_file`, `glob`, `grep`,
`bash`). The orchestrator additionally gets the harness tools (`report_progress`,
`save_version`, `list_versions`, `revert_version`, blocking `request_review`,
`mark_complete`). The workspace is a git repo (versioning + revert), every step is
translated into the shared `UiEvent` protocol over WebSocket, token usage and cost are
accumulated per model id, and old observations are pruned so book-length runs stay
bounded.

## Model tiers

| Tier | Default | Agents |
|---|---|---|
| `translation` | `anthropic/claude-opus-4-1` | `primary-translator`, `final-translator`, `native-critique`, `metadata-generator` |
| `mechanical` | `anthropic/claude-sonnet-4-5` | orchestrator + the other 10 agents |

Edit [`models.json`](models.json) (or point `LEXIS_SMOL_MODELS` at your own file) to swap
providers — LiteLLM ids like `gemini/gemini-2.5-pro`, `openai/gpt-5`,
`deepseek/deepseek-chat`, `openrouter/qwen/qwen3-235b-a22b`, `ollama_chat/qwen3:32b`, or
`provider: "openai"` with an `api_base` for any OpenAI-compatible server. Per-agent
overrides go in `agent_overrides`. Set the matching API key(s) in the environment
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `HF_TOKEN`, …).

Agent definitions live in [`agents/`](agents/) — same frontmatter-plus-prompt files as the
other harnesses (`model:` names a tier, `tools:` names file tools). Bodies are verbatim
from `claude/agents/`.

## Running

```sh
cd smolagents
pip install -r requirements.txt
ANTHROPIC_API_KEY=sk-ant-... ./run.sh     # http://localhost:4701
```

`PORT` overrides the port; `LEXIS_SMOL_DATA_DIR` overrides where projects are stored
(default `smolagents/data/`). `git` must be on `PATH` (versioning); `zip`/`unzip` are used
by the disbinder/packager agents via the `bash` tool.

Tuning env vars: `LEXIS_SMOL_ORCH_MAX_STEPS` (default 500 steps per user turn),
`LEXIS_SMOL_KEEP_RECENT_STEPS` / `LEXIS_SMOL_PRUNED_OBS_CHARS` (bounded-memory pruning).

## Endpoints

Identical to the Claude harness (`POST /api/projects`, `/start`, `/message`, `/review`,
`/interrupt`, versions, files + comments, cover + `/repackage`, `/download`,
`GET /ws?project=<id>&after=<seq>`), so the two web UIs are interchangeable.

## Parity notes

- The review gate blocks inside the `request_review` tool call, exactly like the Claude
  harness — approve or request revisions from the UI.
- Mid-run chat and asset comments are injected between orchestrator steps, so you can
  steer without waiting for a turn boundary.
- Costs are computed per step via litellm's price table when possible, falling back to
  `models.json` `pricing`; totals are per-model in the Usage panel.
- After a server restart the orchestrator resumes with its conversation context
  (compact memory persisted per project) plus the workspace state on disk.
