# lexis

An EPUB translation studio. You give it an EPUB and a target language; an
interactive orchestrator agent on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk)
drives 15 specialized subagents that extract, gloss, translate, audit and
package the book, and checks in with you before handing back the translated
EPUB.

It runs as a single Docker container with a password-protected web UI, and
signs in with your **Claude subscription** from the browser — no API key needed.

## Deploy (Docker)

```sh
cp .env.example .env        # set LEXIS_PASSWORD (and COOKIE_SECURE=0 if not behind https)
docker compose up -d --build
```

Open `http://<host>:8080`, enter the password, then click **Claude** at the
bottom of the sidebar → **Sign in with Claude**. Open the link, approve with
the account that has your subscription, paste the code back. The login is kept
in the `/data` volume along with every project, so it survives restarts and
upgrades.

Alternatives to the web sign-in, in the order Claude Code prefers them:
`ANTHROPIC_API_KEY` (billed per token), then `CLAUDE_CODE_OAUTH_TOKEN` (from
`claude setup-token`), then the web sign-in. Long runs on a subscription may
pause on its rate limits; the translation tier uses Opus, so the plan needs
Opus access.

A published image: merges to `main` that pass CI are pushed to Docker Hub by
`.github/workflows/docker-publish.yml` (set the `DOCKERHUB_USERNAME` /
`DOCKERHUB_TOKEN` secrets, optionally the `DOCKERHUB_REPO` variable).

## Models

The strong model does the actual translating; the cheaper one does everything
mechanical. That split is the lesson of [`docs/LESSONS.md`](docs/LESSONS.md) §1 —
a cheap model on the translation task produced markedly worse prose no matter
how much scaffolding surrounded it.

| Tier | Default | Effort | Agents |
|---|---|---|---|
| Translation quality | `claude-opus-5-5` | `high` | `primary-translator`, `final-translator`, `native-critique`, `critique-charter-generator`, `metadata-generator`, `style-analyzer` |
| Mechanical / extraction | `claude-sonnet-5-5` | `medium` | orchestrator, `ebook-disbinder`, `ebook-packager`, `glossary-manager`, `local-lexicographer`, `narrative-summarizer`, `omission-detector`, `stray-phrase-detector`, `stray-phrase-fixer`, `toc-generator` |

Each tier is a full model ID and an effort level, set in `.env`
(`LEXIS_TRANSLATION_MODEL`, `LEXIS_MECHANICAL_MODEL`, `LEXIS_ORCHESTRATOR_MODEL`,
and the matching `*_EFFORT`). Agent files declare only their tier
(`tier: translation|mechanical` in the frontmatter of [`agents/`](agents/)).
Options worth knowing about:

- `LEXIS_TRANSLATION_MODEL=claude-fable-5-1` — the most capable model, at
  2.5× Opus 5.5's price per token. Worth trying on a book where the prose
  really matters.
- `LEXIS_TRANSLATION_EFFORT=xhigh` — more thinking per chapter on Opus before
  reaching for a pricier model.
- `LEXIS_MECHANICAL_MODEL=claude-haiku-5-5` — much cheaper for extraction and
  audits, but the omission and stray-phrase audits need judgment; try it on a
  short book first.

## Develop

```sh
npm install
LEXIS_PASSWORD=dev npm run dev        # http://localhost:4700
npm run typecheck && npm test
```

`zip`/`unzip` and `git` must be on `PATH` (extraction, packaging and
versioning use them). `LEXIS_DATA_DIR` overrides where projects and the Claude
login live (default `data/`); `LEXIS_DEBUG=1` echoes the Claude Code
subprocess's stderr.

## Pipeline

1. **Preparation** — extract the source EPUB (`ebook-disbinder`).
2. **Initialization** — reading order (`toc-generator`), language/audience parameters incl. register guidance and a translationese watchlist (`metadata-generator`), locale-aware author voice (`style-analyzer`), and a critique charter written in the target language (`critique-charter-generator`).
3. **Extraction + Consolidation (per chapter, sequential)** — summaries and linguistic challenges (`narrative-summarizer`), term extraction (`local-lexicographer`), master glossary updates (`glossary-manager`).
4. **Production (per chapter, sequential, only after all chapters finish stage 3)** — draft (`primary-translator`) ↔ omission audit (`omission-detector`) loop; stray source-language scan (`stray-phrase-detector`) ↔ fix (`stray-phrase-fixer`) loop; native critique (`native-critique`, charter-guided); final polish (`final-translator`); bounded final verification (`native-critique` verification mode → at most one more `final-translator` pass).
5. **Packaging (gated on your review)** — validate and zip a valid EPUB (`ebook-packager`).

See [`docs/LESSONS.md`](docs/LESSONS.md) for what was tried, reverted, and why —
the current design is the last known good state. The orchestrator's system
prompt (sequencing rules, review gate, versioning contract) is in
[`src/prompt.ts`](src/prompt.ts).

## How it works

- **One project = one workspace** under `data/projects/<id>/workspace/` with the
  pipeline's directory layout (`original/`, `notes/`, `draft/`, `critique/`,
  `final/`). The workspace is the agent session's `cwd`, and the session runs
  with `settingSources: []` so nothing from local Claude settings leaks in.
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
- **Usage & cost** — per-model token usage (input, output, cache read/write)
  and cost are shown in the UI's Usage panel with a running project total.
  Token counts update live during a run (accumulated from each assistant
  message's API usage, subagents included). The SDK only reports `modelUsage`
  with `costUSD` on `result` messages at turn boundaries — and the pipeline
  can be one long turn (the review gate blocks inside it) — so live costs are
  estimated from standard per-model API pricing (shown with a `~`) and
  replaced by the SDK's authoritative figures whenever a turn completes.
  Costs are API-equivalent numbers — actual spend on an API key, an estimate
  when running on a subscription.
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
| `POST /api/login`, `POST /api/logout`, `GET /api/session` | app password sign-in |
| `GET /api/claude`, `POST /api/claude/login/{start,code,cancel}`, `POST /api/claude/logout` | link the container to a Claude subscription |
| `GET /healthz` | health check (no sign-in) |

Everything under `/api` (except sign-in) and `/ws` needs the signed cookie.
