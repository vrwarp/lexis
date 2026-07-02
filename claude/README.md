# lexis — Claude Agent SDK harness

A web application that runs the lexis EPUB translation pipeline on the
[Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview). You give
it an EPUB and a target language/context; an interactive orchestrator agent
drives the 14 pipeline subagents and hands you back a translated EPUB — after
you've had a chance to review and request another pass.

## Model tiers

Following the tier strategy the pipeline was reverted back to (see
[`../docs/LESSONS.md`](../docs/LESSONS.md)) — the strong model does the actual
translation, the cheap model does everything else:

| Tier | Model | Agents |
|---|---|---|
| Translation quality | **Opus** | `primary-translator`, `final-translator`, `native-critique`, `metadata-generator` |
| Mechanical / extraction | **Sonnet** | orchestrator, `ebook-disbinder`, `ebook-packager`, `glossary-manager`, `local-lexicographer`, `narrative-summarizer`, `omission-detector`, `stray-phrase-detector`, `stray-phrase-fixer`, `style-analyzer`, `toc-generator` |

Agent definitions live in [`agents/`](agents/) as markdown files with a small
frontmatter (`description`, `model`, `tools`) — the same file-per-agent shape
as the opencode harness — and are loaded into the SDK's `agents` option at
session start. The orchestrator's system prompt (the pipeline sequencing rules,
review gate, and versioning contract) is in [`src/prompt.ts`](src/prompt.ts).

## Running

```sh
cd claude
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start   # http://localhost:4700
```

**Claude subscription instead of an API key:** either log this machine in to
Claude Code (`claude`, then `/login`, choosing your claude.ai account) and start
the server with `ANTHROPIC_API_KEY` unset, or generate a long-lived token with
`claude setup-token` and run `CLAUDE_CODE_OAUTH_TOKEN=<token> npm start`. An
API key in the environment always takes precedence over subscription
credentials. The translation tier pins Opus, so the subscription needs Opus
access (Max), and long runs may pause on subscription rate limits.

`PORT` overrides the port; `LEXIS_DATA_DIR` overrides where projects are stored
(default `claude/data/`); `LEXIS_DEBUG=1` echoes the Claude Code subprocess's
stderr. The SDK spawns its bundled Claude Code runtime, so no separate CLI
install is needed. `zip`/`unzip` and `git` must be on `PATH` (packaging,
extraction, and versioning use them).

## How it works

- **One project = one workspace** under `data/projects/<id>/workspace/` with the
  pipeline's directory layout (`original/`, `notes/`, `draft/`, `critique/`,
  `final/`). The workspace is the agent session's `cwd`, and the session runs
  with `settingSources: []` so nothing from your local Claude settings leaks in.
- **The orchestrator is a long-lived interactive session** (streaming-input
  `query()`); chat messages from the UI are injected into the same session, so
  you can steer mid-run. The session id is persisted and passed as `resume`
  after a server restart or after completion, so follow-ups (another pass, a
  repackage) keep full context.
- **Live UI** — every SDK message is translated into an event (agent text,
  tool calls, subagent start/finish, structured progress) and streamed over a
  WebSocket. Events are also persisted per project (`events.jsonl`) so the feed
  survives reloads.
- **Review gate** — before packaging, the orchestrator must call the in-process
  `request_review` MCP tool, which blocks until you approve or send revision
  instructions from the UI. Revision instructions trigger another
  critique/finalize pass; the gate then re-arms.
- **Versioning** — the workspace is a git repository. The orchestrator
  snapshots at milestones via the `save_version` tool (plus an automatic
  checkpoint at every turn boundary), and the UI shows the version timeline
  with one-click revert. Reverts are non-destructive: the current state is
  snapshotted first and the revert itself is a new version.
- **Usage & cost** — each turn's per-model token usage (input, output, cache
  read/write) and cost from the SDK's `modelUsage` report is accumulated into
  the project and shown in the UI's Usage panel, broken down by model with a
  running total. Costs are the API-equivalent numbers the SDK reports — actual
  spend on an API key, an estimate when running on a subscription.
- **Custom cover (optional)** — upload a cover any time. Before packaging it's
  written into the workspace as `cover_override.*` and the packager uses it.
  After the EPUB exists, "Repackage" swaps the cover deterministically
  (unzip → replace cover entry per the OPF manifest → re-zip with `mimetype`
  first) without spending any tokens; the orchestrator can also be asked to
  repackage via chat for trickier cases.

## Endpoints

| Method & path | Purpose |
|---|---|
| `POST /api/projects` | multipart: `epub`, `name?`, `targetLanguage`, `context?` |
| `POST /api/projects/:id/start` | kick off the pipeline |
| `POST /api/projects/:id/message` | chat with the orchestrator |
| `POST /api/projects/:id/review` | `{decision: approve\|revise, instructions?}` |
| `GET/POST /api/projects/:id/versions`, `POST …/versions/:vid/revert` | versioning |
| `POST /api/projects/:id/cover`, `POST /api/projects/:id/repackage` | custom cover |
| `GET /api/projects/:id/download` | the translated EPUB |
| `GET /ws?project=<id>&after=<seq>` | live event stream (replays history first) |
