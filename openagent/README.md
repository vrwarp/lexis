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

| Tier | Default | Agents |
|---|---|---|
| `translation` | Anthropic `claude-opus-4-1` | `primary-translator`, `final-translator`, `native-critique`, `metadata-generator` |
| `mechanical` | Anthropic `claude-sonnet-4-5` | orchestrator + the other 10 agents |

Edit [`models.json`](models.json) (or point `LEXIS_OA_MODELS` at your own file):
`provider` is one of `anthropic` | `openai` | `google` | `openai-compatible` — the same
`@ai-sdk/*` packages open-agent builds on. `openai-compatible` + `baseURL` covers Ollama,
vLLM, LM Studio, OpenRouter, DeepSeek, Groq, etc. Per-agent `agent_overrides` and a
`pricing` table for cost display. Set the matching key(s): `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` (or `GEMINI_API_KEY`), or `apiKeyEnv`
per tier for custom endpoints.

## Running

```sh
cd openagent
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start     # http://localhost:4702
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
