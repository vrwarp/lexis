# smolagents harness — deep analysis and port design

This document is the design basis for `smolagents/`, the third lexis harness. It analyzes
the Claude Agent SDK harness (`claude/`, the reference implementation that works well) and
the [smolagents](https://github.com/huggingface/smolagents) framework (v1.26.x), maps every
behavior the pipeline depends on onto smolagents primitives, and records the decisions made
so the port performs on par. The motivation for the port is **model diversification**: the
pipeline design stays fixed (see `docs/LESSONS.md`), but the models filling the two tiers
become freely swappable across providers.

---

## 1. What the Claude harness actually does

Reading `claude/src/*.ts` yields this inventory. Every row is a behavior the port must
reproduce (or consciously decline).

### 1.1 Agent architecture

| # | Behavior | Mechanism in the Claude harness |
|---|---|---|
| A1 | Orchestrator is a **long-lived interactive session** | `query()` in streaming-input mode; an async queue feeds user messages into one session; the model is `sonnet` |
| A2 | Orchestrator's job is **sequencing only** | System prompt (`src/prompt.ts`): never translate yourself; delegate via Task; one subagent at a time; hard stage barrier between Extraction and Production |
| A3 | **14 subagents**, file-per-agent definitions | `agents/*.md` frontmatter (`description`, `model`, `tools`) + body as system prompt, loaded into the SDK `agents` option |
| A4 | Subagents get a **fresh context per invocation** | SDK `Task` tool semantics: task prompt in, final report out, no memory across calls |
| A5 | **Model tiers**: strong model only where prose quality is made | Opus: `primary-translator`, `final-translator`, `native-critique`, `metadata-generator`. Sonnet: orchestrator + the other 10 |
| A6 | Subagents work **through the filesystem** | SDK-native tools `Read, Write, Edit, Bash, Glob, Grep`, per-agent allowlists in frontmatter; `cwd` = project workspace |
| A7 | Orchestrator **verifies outputs on disk** before advancing | Prompt mandate + its own Read/Glob access |
| A8 | Web access is disabled | `disallowedTools: ['WebSearch', 'WebFetch']`; `settingSources: []` keeps local config out |

### 1.2 Harness contract (custom tools)

| # | Tool | Behavior |
|---|---|---|
| H1 | `report_progress` | Structured `{phase, chapter?, state, detail?}` → UI progress board |
| H2 | `save_version` | git commit of the whole workspace, human label; no-op when clean |
| H3 | `list_versions` / `revert_version` | git log / non-destructive restore (snapshot first, revert is a new commit) |
| H4 | `request_review` | **Blocks inside the tool call** until the user approves or sends revision instructions; mandatory before packaging; re-arms after revisions |
| H5 | `mark_complete` | Validates the EPUB exists and is >1 KiB inside the workspace, records `outputPath`, flips project to completed |
| H6 | Auto-checkpoint | `saveVersion(…, auto=true)` at every turn boundary |

### 1.3 Server / UX / accounting

| # | Behavior | Mechanism |
|---|---|---|
| S1 | Project store | `data/projects/<id>/` with `project.json`, `events.jsonl`, `workspace/` (a git repo seeded with `source.epub`) |
| S2 | Event feed | Every SDK message → typed `UiEvent` (`agent_text`, `thinking`, `tool_use`, `task_start/end`, `progress`, `review_request/response`, `status`, `version`, `usage`, `error`), appended to `events.jsonl`, pushed over WebSocket, replayable by `seq` |
| S3 | Subagent attribution | `parent_tool_use_id` → agent name map so events show which agent spoke |
| S4 | Mid-run steering | Chat POST injects a user message into the live session at any time |
| S5 | Asset review | UI file browser + per-file comments delivered as `[User comment on asset \`path\`]` messages |
| S6 | Review gate endpoints | `POST /review {approve|revise}` resolves H4 |
| S7 | Session resume | `session_id` persisted; passed as `resume` after restart/completion so follow-ups keep context |
| S8 | Usage & cost | Per-model token totals; live in-turn estimates from a pricing table (the whole pipeline can be one turn because H4 blocks inside it); authoritative SDK `modelUsage`/`costUSD` folded in at turn boundaries |
| S9 | Interrupt | `query.interrupt()` endpoint |
| S10 | Custom cover | Upload → `cover_override.*`; deterministic no-tokens repackage (`unzip` → swap cover per OPF manifest → re-zip `mimetype`-first) |
| S11 | Crash tolerance | On boot, `running`/`awaiting_review` projects downgrade to `awaiting_input`; the workspace and event log carry the state |

### 1.4 Design invariants (from `docs/LESSONS.md`)

1. Strong model on translation-quality agents; cheap tier only for mechanical work.
2. Consistency carried as **data** (`master_glossary.json`), never exhortation; glossary complete before production.
3. Whole chapters, one at a time; never scene-chunking.
4. No LLM "quality gates"; the deterministic-ish checks (structural mapping, script-mismatch grep) suffice.
5. Keep the 14-agent sequential design; change incrementally, never wholesale.

The port keeps the pipeline, prompts, file layout, and sequencing **identical**, and swaps
only the execution substrate.

---

## 2. smolagents: what the framework gives us (v1.26.0, from source)

### 2.1 Execution model

- **`MultiStepAgent`** (abstract) runs a ReAct loop: model → action → observation, up to
  `max_steps`. Memory is a list of typed steps (`SystemPromptStep`, `TaskStep`,
  `ActionStep`, `PlanningStep`, `FinalAnswerStep`); `write_memory_to_messages()` replays all
  steps into the model input each step (no built-in compaction — see gap G5).
- **`ToolCallingAgent`**: native JSON tool calling via the provider's tool-call API
  (`tool_choice="required"`), parallel tool calls executed on a thread pool
  (`max_tool_threads` configurable; multiple calls in one step are possible), falls back to
  parsing a tool call out of text for providers without native support.
- **`CodeAgent`**: the model writes Python that is executed in a sandboxed interpreter
  (local AST-walking executor or remote docker/e2b/modal); tools appear as Python functions.
- A run ends **only** when the model calls the `final_answer` tool (auto-added to every
  agent). `run(task, reset=False)` **continues the same memory** — this is the primitive
  for a persistent chat session. `interrupt()` sets a per-run switch checked each step.
  `run(stream=True)` yields memory steps / stream deltas as they happen.

### 2.2 Multi-agent

- **Managed agents**: any agent constructed with `name` + `description` and passed in
  `managed_agents=[…]` becomes callable *like a tool* with `(task, additional_args?)`.
  Each call goes through `__call__` → `run(...)` with `reset=True` → **fresh memory per
  invocation**, then the child's `final_answer` text is wrapped by the
  `managed_agent.report` template and returned to the caller as the observation. This is
  exactly the SDK `Task` semantics (A4).
- The task/report wrapping templates are overridable per agent via `prompt_templates`
  (`managed_agent.task`, `managed_agent.report`), so the default "you're a helpful agent,
  produce a 3-part report" boilerplate can be replaced with the lexis contract (files on
  disk are the real output; the final answer is a short status report).

### 2.3 Tools

- `Tool` subclass: `name`, `description`, `inputs` (JSON-schema-ish dict), `output_type`,
  `forward()`; arguments validated against the schema before execution
  (`validate_tool_arguments`). The `@tool` decorator builds one from a typed, docstringed
  function. Tools are plain Python — blocking inside `forward()` blocks the agent loop,
  which is precisely what the review gate needs (H4).
- Built-ins are web/search-oriented (`web_search`, `visit_webpage`, `python_interpreter`,
  `user_input`, `final_answer`). **There are no filesystem tools** — no Read/Write/Edit/
  Glob/Grep/Bash equivalents (gap G1).

### 2.4 Models (the reason for this port)

- `Model.generate(messages, stop_sequences, response_format, tools_to_call_from)` is the
  whole interface; implementations: **`LiteLLMModel`** (hundreds of providers via LiteLLM:
  `anthropic/…`, `openai/…`, `gemini/…`, `mistral/…`, `deepseek/…`, `ollama_chat/…`,
  `openrouter/…`), `OpenAIModel` (any OpenAI-compatible endpoint), `InferenceClientModel`
  (HF Inference Providers), `AzureOpenAIModel`, `AmazonBedrockModel`, plus local
  `TransformersModel`/`VLLMModel`/`MLXModel`.
- Each agent takes its **own `Model` instance** → per-agent provider/model mixing is
  native. Tier mapping (A5) becomes a config file entry instead of a hardcoded string.
- `ChatMessage.token_usage` (input/output tokens) is populated per step;
  `ChatMessage.raw` retains the raw provider response (usable for authoritative cost via
  `litellm.completion_cost`). Built-in `Monitor` only sums tokens per agent — per-model
  aggregation and dollars are ours to build (gap G6).

### 2.5 Observability

- `step_callbacks={StepClass: fn}` fire at the end of every step with
  `(memory_step, agent=…)`. This is the event bus for the UI: the callback sees the model
  output text, tool calls, observations, errors, and token usage of each step, and may
  **mutate memory** (the documented pattern for context pruning).
- `AgentLogger`/rich console output and OpenTelemetry instrumentation exist but are
  console/tracing-oriented; the lexis event protocol is built on step callbacks instead.

---

## 3. Capability mapping — Claude Agent SDK → smolagents

| Claude harness behavior | smolagents mechanism | Gap? |
|---|---|---|
| A1 long-lived interactive orchestrator | One `ToolCallingAgent` per project + message queue; each user message = `run(msg, reset=False)` on a session thread | Mid-run injection needs custom code (G3) |
| A2 sequencing-only orchestrator prompt | Same prompt text, adapted: `Task` → managed-agent calls, `TodoWrite` dropped, `final_answer` turn contract added | — |
| A3 file-per-agent definitions | Same `.md` frontmatter format, parsed into `ToolCallingAgent(instructions=body, tools=…, model=tier)` | — (loader is ~40 lines) |
| A4 fresh subagent context per Task | Managed agents: `reset=True` per `__call__` | — |
| A5 model tiers | `models.json`: named tiers → provider model configs; frontmatter `model:` names a tier | — (this is the point of the port) |
| A6 file tools with per-agent allowlists | **Custom toolkit** (§4.2): `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `bash` — all workspace-rooted | **G1: must build** |
| A7 verify-on-disk | Orchestrator gets the same file tools | — |
| A8 no web access | Simply don't hand out web tools | — |
| H1–H5 harness tools | Plain `Tool` subclasses closed over the project; `request_review.forward()` blocks on a `threading.Event` | — |
| H6 auto-checkpoint each turn | `save_version(auto=True)` after every `run()` returns | — |
| S1 project store | Direct port (`projects.py`) | — |
| S2 event feed | Step callbacks → same `UiEvent` JSON schema → same `events.jsonl` + WebSocket | — |
| S3 subagent attribution | Per-agent callbacks close over the agent name (cleaner than tool_use_id mapping) | — |
| S4 mid-run steering | Message queue drained in the orchestrator's `ActionStep` callback → injected as a `TaskStep` before the next model call | **G3: custom** |
| S5 asset comments | Same endpoint; message formatted identically, enters via S4 path | — |
| S6 review endpoints | Resolve the `threading.Event`, pass decision text back as the tool result | — |
| S7 session resume | **No SDK session store exists** → persist a compact form of orchestrator memory (task/output/observations per step) to `orchestrator_memory.json`; rebuild steps on boot | **G4: custom** |
| S8 usage & cost | Per-step `TokenUsage` aggregated per `model_id`; dollars via `litellm.completion_cost` on the raw response when available, else a pricing table (same fallback idea as the Claude harness's live estimates) | **G6: custom** |
| S9 interrupt | `agent.interrupt()` + review-gate abort | — |
| S10 cover repackage | Port `epub.ts` to Python `zipfile` (mimetype first, stored uncompressed) | — |
| S11 crash tolerance | Same status downgrade on boot; workspace/git/event log carry state | — |
| (implicit) SDK context compaction | **None in smolagents** → bounded-memory step callback (§4.5) | **G5: custom** |
| (implicit) Anthropic prompt caching | Provider-dependent; not portable | Accepted non-parity (§6) |

Everything unmapped is buildable with modest custom code; nothing requires forking
smolagents.

---

## 4. Port design

### 4.1 Agent topology

```
OrchestratorSession (thread, one per project)
  └── ToolCallingAgent  model=tier[orchestrator]   max_steps≈500/run
        tools: read_file glob grep bash
               report_progress save_version list_versions revert_version
               request_review mark_complete
        managed_agents (each ToolCallingAgent, fresh memory per call):
               ebook-disbinder toc-generator style-analyzer metadata-generator
               narrative-summarizer local-lexicographer glossary-manager
               primary-translator omission-detector stray-phrase-detector
               stray-phrase-fixer native-critique final-translator ebook-packager
```

**`ToolCallingAgent`, not `CodeAgent`, for the orchestrator.** A CodeAgent could express
"for chapter in chapters: …" as one code block — cheaper, but the orchestrator model would
then *not* look at results between subagents, and mid-run steering (S4) and the review
loop would be blind inside a code block. The Claude orchestrator's value is exactly that
it re-plans after every subagent; JSON tool calling reproduces that step-for-step, and it
is also the most portable across providers (LESSONS #5: don't redesign what works).
`max_tool_threads=1` keeps accidental parallel tool calls sequential (A2 discipline).

**Subagents are `ToolCallingAgent`s too**, for the same portability reason. The agent
`.md` bodies are carried over **verbatim** (they are provider-neutral; nothing in them is
Claude-specific) with only the frontmatter adjusted: `model:` names a tier
(`translation` / `mechanical`), `tools:` uses the port's tool names.

### 4.2 File toolkit (gap G1)

Workspace-rooted, path-jail enforced (`resolve()` must stay under the workspace, `.git`
excluded), mirroring what the SDK tools do in practice:

| Tool | Notes |
|---|---|
| `read_file(path, offset?, limit?)` | Line-numbered output, char cap with truncation notice — keeps big chapters from flooding small-context models |
| `write_file(path, content)` | Creates parent dirs; full overwrite |
| `edit_file(path, old_string, new_string, replace_all?)` | Unique-match contract identical to the SDK's Edit |
| `glob(pattern, path?)` | Sorted matches |
| `grep(pattern, path?, glob?, max_matches?)` | Python `re`, per-line, path:line output — powers the stray-phrase script scan |
| `bash(command, timeout?)` | `bash -lc` with `cwd=workspace`, output truncation; used by disbinder/packager for `unzip`/`zip` exactly as the prompts instruct |

Same trust model as the Claude harness (`bypassPermissions` in a workspace you own):
`bash` is unrestricted but workspace-cwd'd; the two harnesses are equally trusting.

### 4.3 Review gate (H4)

```python
def forward(self, summary):            # runs on the session thread
    project.emit("review_request", …); project.set_status("awaiting_review")
    decision = gate.wait()             # threading.Event + slot, set by POST /review
    return "APPROVED — proceed…" if approved else f"REVISION REQUESTED…\n{instructions}"
```

Blocking inside `forward()` blocks the ReAct loop mid-step — the same "one giant turn"
shape as the Claude harness. The gate also resolves on `interrupt()`/shutdown so the
thread can't leak.

### 4.4 Interactivity (S4) and turn contract

smolagents has no streaming-input mode; the port reproduces it with:

- a per-project **inbox queue**; `send()` enqueues and (if idle) starts a `run()` on the
  session thread;
- the orchestrator's `ActionStep` callback **drains the inbox between steps** and appends
  each message as a `TaskStep` — the next `write_memory_to_messages()` shows it to the
  model as a new user turn, mid-run;
- each `run()` ends when the orchestrator calls `final_answer` (its "turn boundary"): the
  session then auto-checkpoints (H6), persists memory (G4), folds usage, and goes
  `awaiting_input` — unless another message is already queued, in which case the next run
  starts immediately.

The orchestrator prompt spells the contract out: *`final_answer` ends your turn; call it
only when the current request is fully handled or you are blocked on the user.*

### 4.5 Bounded memory (gap G5)

The Claude runtime compacts context automatically; smolagents replays everything forever.
A book-length run (≈10 orchestrator steps × N chapters) would grow unboundedly. The port
registers a pruning callback on the orchestrator: once a step is more than K steps old
(default 12), its observation is truncated to a head slice (default 1,500 chars) with an
elision marker. Old observations here are subagent status reports and `ok` acks — the
durable state lives in `notes/` on disk, which the orchestrator re-reads at will — so
truncation matches the pipeline's own "consistency as data" philosophy (LESSONS #2).
Subagents never need pruning: fresh memory per invocation, bounded steps.

### 4.6 Model configuration (the diversification story)

`smolagents/models.json` (overridable via `LEXIS_SMOL_MODELS`):

```jsonc
{
  "tiers": {
    "translation": {"provider": "litellm", "model_id": "anthropic/claude-opus-4-1", "max_tokens": 32000},
    "mechanical":  {"provider": "litellm", "model_id": "anthropic/claude-sonnet-4-5", "max_tokens": 16000},
    "orchestrator":{"tier": "mechanical"}
  },
  "agent_overrides": { "stray-phrase-detector": {"model_id": "gemini/gemini-2.5-flash"} },
  "pricing": { "anthropic/claude-opus-4-1": {"in": 5, "out": 25}, "…": {} }
}
```

- `provider` ∈ `litellm` (default; hundreds of models) | `openai` (any OpenAI-compatible
  base_url, incl. vLLM/llama.cpp/LM Studio) | `inference_client` (HF) — constructed via
  the corresponding smolagents Model class; extra keys pass through (temperature,
  api_base, reasoning_effort…).
- Swapping the whole pipeline to Gemini, GPT, DeepSeek, or a local Qwen is a two-line
  edit. LESSONS #1 still applies: put a strong model on `translation` or expect worse
  prose — the tier boundary is the experiment knob, not the pipeline.

### 4.7 Usage & cost (gap G6)

Every agent's `ActionStep`/`PlanningStep` callback adds `token_usage` into per-`model_id`
totals on the project (persisted in `project.json`, emitted as throttled `usage` events —
same event schema as the Claude harness). Cost: try `litellm.completion_cost(raw)` for
the step; fall back to the `pricing` table (per-MTok in/out); mark totals `estimated`
when any step lacked authoritative cost. This is strictly better mid-turn than the Claude
harness (which must estimate until a turn boundary) and equivalent at rest.

### 4.8 Persistence & resume (gap G4)

After every run (and after review-gate resolution) the orchestrator memory is serialized
compactly — for each step: kind, task text or model output text, tool calls
(name+arguments), observation, error — to `orchestrator_memory.json`. On boot, steps are
reconstructed (`TaskStep` / `ActionStep` with those fields) so a restarted server
continues the conversation with full context, like `resume` (S7). In-flight steps of a
crashed run are lost in both harnesses; the workspace, git history, and event log carry
the real state either way (S11).

---

## 5. File layout of the port

```
smolagents/
  README.md                  # run instructions, model config guide
  requirements.txt           # smolagents[litellm], fastapi, uvicorn, python-multipart
  models.json                # default tier config (Anthropic models, drop-in swappable)
  agents/*.md                # the 14 definitions (bodies verbatim from claude/agents/)
  public/                    # same web UI (event protocol unchanged)
  src/lexis_smol/
    config.py                # tiers, pricing, env
    projects.py              # project store + UiEvent log        (port of projects.ts)
    versioning.py            # git snapshot/list/revert           (port of versioning.ts)
    epub.py                  # deterministic cover replacement    (port of epub.ts)
    fs_tools.py              # §4.2 toolkit
    harness_tools.py         # §1.2 tools incl. blocking review gate
    agent_defs.py            # frontmatter loader → agent factories
    prompt.py                # orchestrator system prompt         (port of prompt.ts)
    orchestrator.py          # session thread, inbox, callbacks→events, usage, memory
    server.py                # FastAPI + WebSocket, same endpoints as server.ts
  run.sh                     # uvicorn launcher
```

The repo-root directory is named `smolagents/` for symmetry with `claude/` and
`opencode/`; it contains no `__init__.py`, so it can never shadow the installed
`smolagents` package (regular packages win over namespace portions on `sys.path`).

---

## 6. Accepted non-parity (and why it's acceptable)

| Claude harness feature | Status in port | Rationale |
|---|---|---|
| Anthropic prompt caching economics | Provider-dependent | LiteLLM passes caching through for Anthropic; other providers have their own (or no) caching. Cost, not correctness. |
| `thinking` blocks | Approximated | The ReAct "thought" text before each tool call is emitted as the same event stream; extended-thinking models surface via their providers where supported. |
| Claude Code subscription auth | Not applicable | The port uses provider API keys via env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …). |
| SDK permission system | Not applicable | The Claude harness already ran `bypassPermissions`; the port is equally trusting inside the workspace jail. |
| `TodoWrite` | Dropped | Progress is the `report_progress` board; an internal todo list added no pipeline value. |
| Compaction quality | Cruder (head-truncation vs. summarization) | Durable state is on disk by design; observations being truncated are acks and status reports. Tunable via env. |

## 7. Parity risks to watch in real runs

1. **Weak tool-callers as orchestrator.** The orchestrator makes hundreds of consecutive
   tool calls; models with sloppy JSON tool calling will need `tool_choice="required"`
   (default here) and may still wander. Mitigation: keep the orchestrator on a competent
   mid-tier model; the tier config makes that one line.
2. **Long chapters vs. small output windows.** `primary-translator` writes a whole chapter
   in one `write_file` call. Models with small max output need chapter-sized
   `max_tokens` config (exposed per tier) — or will truncate, which `omission-detector`
   then catches (the pipeline's own safety net).
3. **Glossary discipline varies by model.** The glossary-as-data mechanism (LESSONS #2)
   is model-agnostic, but adherence is not automatic; the stray/omission loops and
   critique pass are the guardrails. A/B chapter comparisons before committing a
   provider swap for `translation` remain advisable (LESSONS #5).

## 8. Verification plan

- Unit-ish: path jail (escapes rejected), edit uniqueness contract, glob/grep outputs,
  cover replacement on a synthetic EPUB, versioning round-trip (save→revert→save).
- Harness dry-run: a `MockModel` (scripted `ChatMessage`s) drives the orchestrator through
  progress → subagent call → review gate → approval → completion, asserting the event
  sequence and status transitions without any API key.
- Live smoke: tiny 2-chapter EPUB through the full pipeline on a cheap model pair.
