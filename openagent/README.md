# lexis — open-agent harness

The lexis EPUB translation pipeline on the framework substrate of
[AFK-surf/open-agent](https://github.com/AFK-surf/open-agent): **Vercel AI SDK v5** with
open-agent's copilot-plugin architecture — provider layer, Mustache named-prompt registry,
tools that nest LLM calls (their multi-agent pattern), a step-capped `streamText`/
`generateText` agent loop, and token tracking.

Open-agent ships as a full self-hostable platform (NestJS + Prisma + GraphQL), not a
library, so this harness adopts its substrate and architecture in a compact standalone
service that follows this repo's harness conventions — same pipeline, prompts, workspace
layout, git versioning, review gate, endpoints, and web UI as [`../claude/`](../claude/)
and [`../smolagents/`](../smolagents/). Full analysis and the integration options
considered: [`../docs/OPENAGENT_ANALYSIS.md`](../docs/OPENAGENT_ANALYSIS.md). Pipeline
design invariants: [`../docs/LESSONS.md`](../docs/LESSONS.md).

## Architecture (one paragraph)

An Express + WebSocket server (port **4702**) exposes the shared lexis endpoints and UI.
Each project gets a long-lived orchestrator session: one `generateText` call per user
turn with `stopWhen: stepCountIs(500)`, persisted `ModelMessage[]` history for resume,
`prepareStep` draining queued chat messages mid-run, and `onStepFinish` translating every
step into the shared `UiEvent` protocol plus per-model token/cost totals. The 14 pipeline
agents are tools in the orchestrator's toolset — each executes a **nested** `generateText`
with that agent's prompt (from `agents/*.md`, Mustache-rendered), its tier's model, its
file-tool allowlist, and a fresh message array per invocation (open-agent's
nested-prompt-call pattern, made agentic). The blocking `request_review` tool, git-backed
`save_version`/`revert_version`, `report_progress`, and `mark_complete` complete the
harness contract; the workspace-jailed file toolkit (`read_file`, `write_file`,
`edit_file`, `glob`, `grep`, `bash`) matches the other harnesses' contracts exactly.

## Model tiers

The default [`models.json`](models.json) uses **OpenRouter free models** (all `:free`, all
tool-capable, all keeping reasoning in a separate field so it never leaks into output),
reached through OpenRouter's OpenAI-compatible endpoint:

| Tier | Default (free) | Agents |
|---|---|---|
| `translation` | `nvidia/nemotron-3-super-120b-a12b:free` — capable + clean multilingual output, 1M ctx | `primary-translator`, `final-translator`, `native-critique`, `metadata-generator` |
| `mechanical` | `openai/gpt-oss-20b:free` — fast, reliable tool-caller | the other 10 agents |
| `orchestrator` | `openai/gpt-oss-20b:free` — fast tool-calling for the high-volume sequencing role | the orchestrator |

The strongest model sits on `translation` per [`../docs/LESSONS.md`](../docs/LESSONS.md) #1;
the orchestrator uses a fast small model because it makes the most calls. Get a key at
<https://openrouter.ai/keys> and set `OPENROUTER_API_KEY`.

> **Free-tier reality — read this before translating a whole book.** OpenRouter's free
> (`:free`) models are *shared upstream capacity*. Two things bite:
> 1. **Upstream 429s.** Any free model can return `HTTP 429 "temporarily rate-limited upstream"`
>    at any moment (popular models routed to busy providers like Venice are 429 almost
>    constantly — that's why the defaults avoid them). The harness **auto-retries with
>    Retry-After backoff** (a resilient `fetch` in `src/diagnostics.ts`), so runs survive
>    transient limits; you'll just see `rate-limit` lines in the console and the run slows down.
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
>   commented `//anthropic-alternative` block into `models.json` — paid providers have no daily
>   cap and cost a few dollars per book. Keep the free config for smoke-testing a chapter or two.
>
> Errors surface with the real cause (status, upstream provider, retry-after) in both the UI
> activity feed and the console; set `LEXIS_OA_DEBUG=1` for per-step logs and stack traces.

Edit [`models.json`](models.json) (or point `LEXIS_OA_MODELS` at your own file):
`provider` is one of `anthropic` | `openai` | `google` | `openai-compatible` — the same
`@ai-sdk/*` packages open-agent builds on. `openai-compatible` + `baseURL` covers OpenRouter
(the default), Ollama, vLLM, LM Studio, DeepSeek, Groq, etc.; `apiKeyEnv` names the env var
holding the key. Per-agent `agent_overrides` and a `pricing` table for cost display. Set
the matching key(s): `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY` (or `GEMINI_API_KEY`).

## Running

```sh
cd openagent
npm install
OPENROUTER_API_KEY=sk-or-... npm start     # http://localhost:4702 (free-model default)
# or, with paid Anthropic tiers swapped into models.json:
# ANTHROPIC_API_KEY=sk-ant-... npm start
```

`PORT` overrides the port; `LEXIS_OA_DATA_DIR` overrides project storage (default
`openagent/data/`). `git` must be on `PATH` (versioning); `zip`/`unzip` are used by the
disbinder/packager agents via the `bash` tool. Tuning: `LEXIS_OA_ORCH_MAX_STEPS`
(default 500 per user turn), `LEXIS_OA_KEEP_RECENT_MESSAGES` / `LEXIS_OA_PRUNED_OUTPUT_CHARS`
(bounded-memory pruning).

Tests (no API keys needed — scripted mock model drives the full loop):

```sh
npm test
```

## Endpoints

Identical to the other harnesses (`POST /api/projects`, `/start`, `/message`, `/review`,
`/interrupt`, versions, files + comments, cover + `/repackage`, `/download`,
`GET /ws?project=<id>&after=<seq>`), so the web UIs are interchangeable.
