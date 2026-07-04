# lexis — smolagents harness

The lexis EPUB translation pipeline running on
[smolagents](https://github.com/huggingface/smolagents), built to **diversify the models**
behind the pipeline: the design mirrors the Claude Agent SDK harness
([`../claude/`](../claude/)) — same prompts, sequencing, review gate, versioning, and web
UI — except EPUB extraction + validation run deterministically in code (not via an LLM
agent), so the pipeline is 13 model-driven subagents rather than 14. Every model slot is a
config entry that can point at
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

The default [`models.json`](models.json) uses **OpenRouter free models** (all `:free`, all
tool-capable, all keeping reasoning in a separate field so it never leaks into output):

| Tier | Default (free) | Agents |
|---|---|---|
| `translation` | `nvidia/nemotron-3-super-120b-a12b:free` — capable, clean multilingual output, 1M ctx | `primary-translator`, `final-translator`, `native-critique`, `metadata-generator` |
| `mechanical` | `nvidia/nemotron-3-super-120b-a12b:free` | the other 10 agents |
| `orchestrator` | `nvidia/nemotron-3-super-120b-a12b:free` | the orchestrator |

All tiers use Nemotron-Super here because smolagents always calls tools with
`tool_choice="required"`, and this model handles that reliably where several other free
models (e.g. `gpt-oss`) answer it with an HTTP 429. Get a key at
<https://openrouter.ai/keys> and set `OPENROUTER_API_KEY`. (The openagent harness, which
doesn't force `tool_choice`, pairs Nemotron with the faster `gpt-oss-20b`.)

> **Free-tier reality — read this before translating a whole book.** OpenRouter's free
> (`:free`) models are *shared upstream capacity*. Two things bite:
> 1. **Upstream 429s.** Any free model can return `HTTP 429 "temporarily rate-limited upstream"`
>    at any moment (popular models routed to busy providers like Venice are 429 almost
>    constantly — that's why the defaults avoid them). The harness **auto-retries with
>    Retry-After backoff**, so runs survive transient limits; you'll just see `rate-limit`
>    lines in the console and the run slows down.
> 2. **Account daily cap.** Across *all* free models combined: **50 requests/day** by default,
>    **1,000/day** after buying a small credit balance (~$10), plus ~20 req/min.
>
> A ~100k-word, ~15-chapter novel (e.g. *Ender's Game*) is **~1,000 requests** end-to-end, so:
> - **50 RPD** → about a chapter's pipeline per day; a whole novel over a couple of weeks.
>   **Perfectly fine unhurried** — the workspace is git-checkpointed and the orchestrator
>   resumes across restarts, so run a little each day and pick up where you left off.
> - **1,000 RPD** (after the deposit) → a book in a day or two, though you'll still wait
>   through upstream-429 backoff.
> - **For a smooth run:** add your own upstream key (BYOK,
>   <https://openrouter.ai/settings/integrations>) to bypass the shared limits, or lift the
>   commented `//anthropic-alternative` block into `models.json` — paid models have no daily
>   cap and cost a few dollars per book. Keep the free config for smoke-testing a chapter or two.
>
> Errors surface with the real cause (status, upstream provider, retry-after) in both the UI
> activity feed and the console; set `LEXIS_SMOL_DEBUG=1` for per-step logs and stack traces.

Swap providers freely — LiteLLM ids like `gemini/gemini-2.5-pro`, `openai/gpt-5`,
`deepseek/deepseek-chat`, `openrouter/<any-model>`, `ollama_chat/qwen3:32b`, or
`provider: "openai"` with an `api_base` for any OpenAI-compatible server. Per-agent
overrides go in `agent_overrides`. Point `LEXIS_SMOL_MODELS` at your own file to override
the default. Set the matching API key(s) in the environment (`OPENROUTER_API_KEY`,
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `HF_TOKEN`, …).

Agent definitions live in [`agents/`](agents/) — same frontmatter-plus-prompt files as the
other harnesses (`model:` names a tier, `tools:` names file tools). Bodies are verbatim
from `claude/agents/`.

## Running

```sh
cd smolagents
pip install -r requirements.txt
OPENROUTER_API_KEY=sk-or-... ./run.sh     # http://localhost:4701 (free-model default)
# or, with paid Anthropic tiers swapped into models.json:
# ANTHROPIC_API_KEY=sk-ant-... ./run.sh
```

`PORT` overrides the port; `LEXIS_SMOL_DATA_DIR` overrides where projects are stored
(default `smolagents/data/`). `git` must be on `PATH` (versioning); `zip`/`unzip` are used
by the packager agent via the `bash` tool (source extraction is deterministic, in code).

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
