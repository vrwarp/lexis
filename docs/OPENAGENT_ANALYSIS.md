# open-agent harness — deep analysis and port design

This document is the design basis for `openagent/`, the fourth lexis harness, built after
studying [AFK-surf/open-agent](https://github.com/AFK-surf/open-agent) (commit `1a85d76`)
the same way `docs/SMOLAGENTS_ANALYSIS.md` studied smolagents: read the source, inventory
what the framework provides, map every behavior the lexis pipeline needs onto it, and
record the decisions. The pipeline itself stays fixed (`docs/LESSONS.md`); the goal is a
third execution substrate with freely swappable models.

---

## 1. What open-agent actually is

Open-Agent bills itself as an "open-source alternative to Claude Agent SDK, ChatGPT
Agents, and Manus". Reading the repo, it is a **self-hostable productivity platform**
(an AFFiNE-derived monorepo: blocksuite block editor, React web app, Electron shell,
NestJS + Prisma + GraphQL backend, Docker deployment) whose agentic capability lives in
one backend plugin: `packages/backend/server/src/plugins/copilot/` (~16k LOC, 84 files).

It is **not a library**. Every package is a private workspace package
(`@afk/*`), wired to NestJS dependency injection, a Prisma/Postgres schema, Redis cache,
and the platform's config/event systems. There is no importable "agent core" published
anywhere. That constraint drives the port design in §4.

### 1.1 The copilot plugin's architecture (the actual framework)

| Layer | What it is (from source) |
|---|---|
| **Model substrate** | **Vercel AI SDK v5** (`ai` ^5.0.10) with `@ai-sdk/anthropic` (official + Vertex), `@ai-sdk/google` (+ Vertex), `@ai-sdk/openai`, `@ai-sdk/openai-compatible`, `@ai-sdk/perplexity`, plus FAL/Morph specialists |
| **Agent loop** | `streamText({ model, system, messages, tools, stopWhen: stepCountIs(MAX_STEPS) })` — the AI SDK's built-in multi-step tool-calling loop; `MAX_STEPS = 20` (`providers/provider.ts`) |
| **Providers** | Abstract `CopilotProvider` (NestJS injectable) per vendor family: capability-based model selection (`ModelFullConditions` — input/output modality matching), provider registry + factory with fallback (`getProviderByModel`), unified `text` / `streamText` / `streamObject` / `structure` / `embedding` methods, rate-limit-aware error mapping, `TokenTracker.trackAICall` usage accounting |
| **Prompt registry** | A catalog of ~dozens of **named prompts** (`prompt/prompts.ts`, seeded into Postgres, runtime-editable): each `{name, model, optionalModels, config, messages[]}` with **Mustache** templating, param validation against declared params, predefined params (`oa::date`, `oa::language`, `oa::timezone`), token counting per prompt (`prompt/chat-prompt.ts`) |
| **Tools** | AI SDK `tool()`s built by factories (`tools/*.ts`) through a `createTool` wrapper adding telemetry + error envelopes. Two big patterns: **(a) nested LLM calls** — a tool looks up another named prompt, picks its provider, and runs `structure()`/`streamText()` inside the tool (`task_analysis`, `code_artifact`, `doc_compose`, `conversation_summary`, `make_it_real`) — this is the README's "multi-agent collaboration"; **(b) streaming tools** — long-running tools pipe incremental output into the main response stream via a `TransformStream` merged with the model stream (`tool-incomplete-result` chunks, `mergeStreams`) |
| **Planning** | `task_analysis` (structured breakdown via a dedicated prompt+model) and `todo_list`/`mark_todo` (Redis-cache-backed todo state) — plan-as-tool, not a separate planner loop |
| **Sessions** | Prisma-backed chat sessions and message history; SSE streaming controller + GraphQL resolvers; per-session context (attached docs/files with embeddings for semantic search) |
| **Workflow engine** | A separate graph executor (`workflow/`): nodes bound to named prompts, params flowing between nodes, presets like `presentation`. Linear/graph content generation — fire-and-forget, no human gate mid-graph, no filesystem state |

### 1.2 What "multi-agent" means in open-agent

There is no Task-tool/subagent-session concept like the Claude Agent SDK, and no
managed-agents concept like smolagents. Multi-agent composition happens as **LLM calls
nested inside tools**, each using a *different named prompt bound to its own model*
(possibly a different vendor — the "all the frontier models collaborate" claim). The
top-level chat prompt (e.g. `Chat With Open-Agent`, default `claude-sonnet-4`, optional
GPT-5/o3/Gemini-2.5) decides when to invoke them, inside one AI-SDK step loop.

That is structurally the same shape as the lexis orchestrator: a top-level agent that
never does substantive work itself, delegating to specialist prompt+model pairs via
tools. The lexis subagents map onto open-agent's nested-prompt-call pattern one-to-one.

---

## 2. Fit assessment against the lexis pipeline

What lexis needs (behavior inventory in `docs/SMOLAGENTS_ANALYSIS.md` §1) vs. what the
copilot plugin has:

| lexis requirement | open-agent status |
|---|---|
| Orchestrator loop with hundreds of sequential tool steps | AI SDK loop exists but `MAX_STEPS = 20` hardcoded; needs a bigger cap (config, one line) |
| 14 specialist agents on 2 model tiers | Named-prompt catalog + nested-call tools: direct fit (prompt per agent, model per prompt) |
| Filesystem workspace (original/ notes/ draft/ critique/ final/) | **Absent.** Copilot tools operate on docs/embeddings/web/sandboxes, not a project directory. File toolkit must be built (same gap as smolagents, G1) |
| Blocking human review gate inside the run | **Absent.** Chat sessions are request/response; the workflow engine has no human gate either. Buildable: a tool whose async `execute` awaits a promise resolved by an HTTP endpoint — the AI SDK loop awaits tool execution, so the "one giant turn" shape survives |
| Mid-run steering | **Absent** in copilot (next user message = next request). AI SDK v5's `prepareStep` hook can append queued user messages between steps — better than what open-agent itself does |
| Git versioning, progress board, usage/cost, event feed, resume | Platform-specific in open-agent (Prisma, GraphQL, their UI). Lexis already has its own contract for all of these — reuse the existing project store/event protocol/web UI |
| Deterministic EPUB cover swap | Absent; ported code exists in this repo (`claude/src/epub.ts`) |

The **workflow engine is the wrong substrate** for the pipeline despite looking
pipeline-shaped: lexis's draft/validation loops are conditioned on *file contents*
(`STATUS: COMPLETE`, `"status": "CLEAN"`), production is gated on a human decision
mid-run, and every stage reads/writes a shared workspace. The chat-agent loop with tools
is the right substrate — the same conclusion open-agent itself embodies by shipping its
agentic features as chat tools, and the same shape as the other two lexis harnesses.

---

## 3. Integration options considered

1. **Run the whole platform, add lexis as a copilot sub-plugin.** Requires Postgres,
   Redis, their GraphQL app, and forking the monorepo; the lexis "harness" would become a
   patch series against a 4,000-file product instead of a directory in this repo. The
   pipeline gains nothing from the platform (docs, embeddings, canvas are orthogonal).
   Rejected.
2. **Vendor the copilot plugin.** It does not compile outside NestJS/Prisma/their config
   and event buses; extracting it means rewriting its edges anyway. Rejected.
3. **Adopt the framework open-agent is built on, and its architecture, as a standalone
   harness.** Open-agent's real agentic substance = **AI SDK v5 + a provider registry +
   a Mustache named-prompt catalog + tool factories (incl. nested-LLM-call tools and
   blocking/streaming tools) + step-capped agent loop + token tracking**. All of that is
   reproducible faithfully in a compact TypeScript service that follows the repo's
   harness conventions (own directory, own web UI, same endpoints). **Chosen.**

This mirrors the smolagents port precisely: there, the framework was pip-installable and
we wrote the missing harness pieces around it; here, the framework's installable core is
the AI SDK v5 stack (the exact packages open-agent depends on), and the copilot plugin's
architecture is the blueprint for the code around it.

---

## 4. Port design (`openagent/`)

TypeScript/Node (same language as open-agent's backend and the `claude/` harness),
Express + ws (the repo's existing server shape — NestJS/Prisma/GraphQL are platform
plumbing, not agent substance; see §6).

```
openagent/
  package.json            # ai@^5 + @ai-sdk/anthropic|openai|google|openai-compatible, mustache, zod, express, multer, ws
  models.json             # tier config: translation / mechanical / orchestrator → provider+model (+pricing table)
  agents/*.md             # the 14 definitions — bodies verbatim, frontmatter: model tier + tools
  public/                 # the shared lexis web UI (same UiEvent protocol)
  src/
    types.ts              # UiEvent, phases, usage shapes        (from claude/src/types.ts)
    config.ts             # tier → AI SDK LanguageModel factory  (open-agent provider layer, distilled)
    prompts.ts            # named-prompt registry with Mustache finish()   (their ChatPrompt, file-seeded)
    fs-tools.ts           # read_file/write_file/edit_file/glob/grep/bash as AI SDK tool()s, workspace-jailed
    harness-tools.ts      # report_progress/save_version/list_versions/revert_version/request_review/mark_complete
    subagents.ts          # one tool per pipeline agent: nested generateText with the agent's prompt+tier model
    orchestrator.ts       # session: streamText loop, stepCountIs(cap), prepareStep steering, onStepFinish events/usage, history persistence + pruning
    prompt.ts             # orchestrator system prompt           (from claude/src/prompt.ts, adapted)
    projects.ts           # project store + events.jsonl         (from claude/src/projects.ts)
    versioning.ts         # git snapshot/list/revert             (from claude/src/versioning.ts)
    epub.ts               # deterministic cover swap             (from claude/src/epub.ts)
    server.ts             # same endpoints, port 4702            (from claude/src/server.ts)
```

### 4.1 The orchestrator on the AI SDK loop

Each user message runs one `streamText` call:

```ts
streamText({
  model: tierModel('orchestrator'),
  system: orchestratorPrompt(meta),
  messages: history,                       // persisted ModelMessage[]
  tools: { ...fileTools, ...harnessTools, ...subagentTools },
  stopWhen: stepCountIs(ORCH_MAX_STEPS),   // 500 default — open-agent's 20 is for chat turns, not books
  prepareStep: injectQueuedUserMessages,   // mid-run steering (S4)
  onStepFinish: emitEventsTrackUsagePersist,
  abortSignal: interruptController.signal,
})
```

- The run ends when the model stops calling tools (its final text = the turn's closing
  message) — the AI SDK's natural termination, so no `final_answer` convention is needed
  (closer to the Claude harness's turn shape than the smolagents port).
- `onStepFinish` translates each step into the shared event protocol (assistant text →
  `agent_text`, tool calls → `tool_use`/`task_start`/`task_end`, errors → `error`),
  accumulates per-model token usage (AI SDK v5 reports `inputTokens`/`outputTokens`,
  incl. `cachedInputTokens` where providers expose it), and checkpoints history.
- `prepareStep` drains the project inbox and appends queued messages as user turns for
  the next step — the port's mid-run steering, one capability *beyond* what open-agent's
  own chat has.
- History = the AI SDK `ModelMessage[]` (JSON-serializable), persisted per project and
  reloaded on boot → restart-resume, same as the smolagents port. Old tool outputs
  beyond a recency window are truncated before each run (bounded memory; durable state
  lives in `notes/` on disk).

### 4.2 Subagents as nested-call tools (the open-agent pattern)

Each of the 14 agents becomes a tool named after it (`ebook_disbinder`, …,
`final_translator`) with input `{ task: string }`, exactly like open-agent's
`code_artifact`/`doc_compose` tools wrap "look up named prompt → pick its model → run a
nested LLM call". Here the nested call is itself agentic:

```ts
generateText({
  model: tierModel(agent.tier, agent.name),      // per-agent override supported
  system: promptRegistry.get(agent.name).finish(params),   // Mustache; body verbatim from claude/agents/
  messages: [{ role: 'user', content: task }],
  tools: fileToolsSubset(agent.tools),           // per-agent allowlist from frontmatter
  stopWhen: stepCountIs(SUBAGENT_MAX_STEPS),     // 30 default
})
```

Fresh message array per invocation = fresh context per Task (A4 parity). The tool
returns the subagent's final text as the observation; its intermediate steps are emitted
to the event feed attributed to the agent's name.

### 4.3 Review gate, harness tools, file tools

Identical contracts to the other harnesses. `request_review.execute` awaits a promise
resolved by `POST /review` — the AI SDK awaits tool execution, so the loop blocks
mid-turn precisely like the Claude harness's MCP tool and the smolagents `threading.Event`
tool. The file toolkit is the same six tools with the same jail and truncation contracts
as the smolagents port (specified in `SMOLAGENTS_ANALYSIS.md` §4.2), expressed as AI SDK
`tool()`s with Zod input schemas.

### 4.4 Model diversification

`openagent/models.json`, same tier shape as the smolagents harness:

- `provider: "anthropic" | "openai" | "google" | "openai-compatible"` → the matching
  `@ai-sdk/*` factory (`createAnthropic`, `createOpenAI`, `createGoogleGenerativeAI`,
  `createOpenAICompatible` — the last covers Ollama, vLLM, LM Studio, OpenRouter,
  DeepSeek, Groq, etc. via `baseURL`).
- These are the very packages open-agent depends on, so the diversification story is the
  same as theirs: default `translation` → Anthropic Opus-class, `mechanical` → Sonnet-
  class, swappable to GPT-5/Gemini-2.5/DeepSeek/local with two lines and an API key.
- Per-agent `agent_overrides` and a `pricing` fallback table (AI SDK reports tokens, not
  dollars) — same cost model as the other harnesses.

## 5. Capability mapping summary

| lexis behavior | Claude SDK harness | smolagents harness | **open-agent harness** |
|---|---|---|---|
| Agent loop | SDK runtime | smolagents ReAct loop | AI SDK v5 `streamText` + `stepCountIs` (open-agent's loop) |
| Subagent isolation | `Task` tool | managed agents (fresh memory) | nested `generateText` per tool call (fresh messages) |
| Agent definitions | `agents/*.md` → SDK `agents` | same files → `ToolCallingAgent`s | same files → named-prompt registry (Mustache), open-agent style |
| Review gate | blocking MCP tool | blocking `threading.Event` tool | blocking async tool promise |
| Mid-run steering | streaming input | inbox → observation injection | inbox → `prepareStep` message injection |
| Bounded memory | SDK compaction | observation pruning callback | history tool-output truncation between runs |
| Resume | SDK `resume` id | compact memory JSON | `ModelMessage[]` JSON |
| Usage/cost | SDK `modelUsage` + estimates | per-step TokenUsage + litellm/table | per-step AI SDK usage + table (open-agent's TokenTracker idea) |
| Events/UI | SDK messages → UiEvents | step callbacks → UiEvents | `onStepFinish`/tool wrappers → UiEvents |
| Model mixing | Anthropic tiers | any LiteLLM/OpenAI/HF id per tier | any `@ai-sdk/*` provider per tier |

## 6. Accepted deviations from open-agent itself (and why)

| open-agent trait | Port's choice | Rationale |
|---|---|---|
| NestJS + Prisma + GraphQL + Redis platform | Express + ws + JSON/git on disk | Platform plumbing, not agent substance; the repo's harness convention is a small self-contained service; lexis state (workspace files, git history, events.jsonl) needs no database |
| `MAX_STEPS = 20` | 500 (orchestrator), 30 (subagents), configurable | 20 fits a chat turn; a book is hundreds of sequential steps in one gated turn |
| Prompt catalog in Postgres, runtime-editable | Seeded from `agents/*.md` files at boot | The file-per-agent format is this repo's cross-harness convention; runtime editing adds a DB for no pipeline value |
| Their web UI (blocksuite app) | The shared lexis UI | The pipeline needs the progress board / review gate / versions / asset-comment UX that already exists and is protocol-compatible across harnesses |
| Specialist providers (FAL images, Morph edits, Perplexity search) | Not carried over | The pipeline is text-only by design; web access is deliberately disabled (A8) |
| Todo tools (Redis-backed) | `report_progress` board instead | Same role, already part of the lexis contract |

## 7. Risks to watch in real runs

1. **AI SDK tool-call fidelity varies by provider** — same risk class as the smolagents
   port; `stopWhen` + explicit sequencing prompt mitigate; keep the orchestrator on a
   competent mid-tier model.
2. **`prepareStep` message injection is an approximation in persisted history** — the
   model sees injected messages at the right step, but the persisted transcript appends
   them at run boundaries; content is preserved, exact interleaving is not. Same
   accepted trade-off class as the smolagents observation-injection.
3. **Long chapters vs. output windows** — identical to the other harnesses: set
   chapter-sized `maxOutputTokens` per tier; `omission-detector` is the safety net.

## 8. Verification plan

Same shape as the smolagents harness: unit checks (jail, edit contract, glob/grep, cover
swap, versioning round-trip); a **mock-model end-to-end run** using the AI SDK's own
`MockLanguageModelV2` (scripted tool calls driving progress → subagent → review gate →
approve → `mark_complete`, asserting the event sequence, status transitions, usage
accumulation, and history persistence — no API keys); live server endpoint checks; then
a live 2-chapter EPUB on a cheap model pair.
