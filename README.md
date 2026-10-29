# lexis

An EPUB translation studio. You give it an EPUB and a target language; a
code-driven engine runs thirteen specialized agents on the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) to extract,
gloss, translate, audit, critique, polish and verify every chapter — several
chapters at a time — and checks in with you before packaging the translated
EPUB. You watch every chapter and stage in a live matrix, open any step's log,
and steer: pause, retry, re-run a chapter from any stage, change the
instructions mid-run, or ask the assistant.

It runs as a single Docker container with a password-protected web UI, and
signs in with your **Claude subscription** from the browser — no API key needed.

## Deploy (Docker)

```sh
cp .env.example .env        # set LEXIS_PASSWORD and LEXIS_PUBLIC_URL
docker compose up -d --build
```

Put it behind your https reverse proxy, open `LEXIS_PUBLIC_URL`, sign in with
the password and create a passkey when asked (see [Security](#security)). Then
click **Claude** at the bottom of the sidebar → **Sign in with Claude**. Open the link, approve with
the account that has your subscription, paste the code back. The login is kept
in the `/data` volume along with every project, so it survives restarts and
upgrades.

Alternatives to the web sign-in, in the order Claude Code prefers them:
`ANTHROPIC_API_KEY` (billed per token), then `CLAUDE_CODE_OAUTH_TOKEN` (from
`claude setup-token`), then the web sign-in. Long runs on a subscription may
pause on its rate limits; the translation tier uses Opus, so the plan needs
Opus access.

Merges to `main` that pass CI are pushed to Docker Hub (see [CI](#ci)), so a
host can also run the published image instead of building.

## Security

lexis runs agents with full tool access inside its container and holds your
Claude login, so the web UI is locked down for being on the internet:

- **Passkeys first, password as backup.** Sign in with the password the first
  time and lexis asks you to create a passkey (Face ID, Touch ID, Windows Hello,
  a phone, or a security key). From then on the sign-in screen leads with the
  passkey; the password keeps working as the backup for a device without one.
  Passkeys require user verification, are bound to `LEXIS_PUBLIC_URL`, and
  can't be phished. Manage them under **Security** in the sidebar.
- **Password attempt limits.** 5 wrong passwords per client address and 20
  overall per 15 minutes, then `429`. Set `LEXIS_TRUST_PROXY` so the limit sees
  real client addresses behind a proxy. Because the password stays valid, make
  it long and random.
- **Real sessions.** The cookie is a random token (`HttpOnly`, `SameSite=Strict`,
  `__Host-` over https); only its hash is stored. Signing out ends it on the
  server, sessions expire after 14 idle days or 30 days in all, and **Security**
  lists every signed-in browser with a sign-out button for each.
- **Confirm before changing sign-in.** Adding or removing a passkey needs a
  sign-in or confirmation (passkey, or the password) from the last 10 minutes,
  so a stolen session alone can't plant its own passkey.
- **Same-origin only.** Writes and WebSocket connections from any other origin
  are refused; strict Content-Security-Policy, `frame-ancestors 'none'`,
  `nosniff`, `no-referrer`, and HSTS over https.

Lost a device? Sign in with the password and remove its passkey, or from the
host:

```sh
docker compose exec lexis node dist/cli.js status          # passkeys and signed-in browsers
docker compose exec lexis node dist/cli.js signout-all     # end every session
docker compose exec lexis node dist/cli.js reset-passkeys  # forget all passkeys and sessions
```

## Models

The strong model does the actual translating; the cheaper one does everything
mechanical. That split is the lesson of [`docs/LESSONS.md`](docs/LESSONS.md) §1 —
a cheap model on the translation task produced markedly worse prose no matter
how much scaffolding surrounded it.

| Tier | Default | Effort | Agents |
|---|---|---|---|
| Translation quality | `claude-opus-5-5` | `high` | `primary-translator`, `final-translator`, `native-critique`, `critique-charter-generator`, `metadata-generator`, `style-analyzer` |
| Mechanical / extraction | `claude-sonnet-5-5` | `medium` | the assistant, `ebook-packager`, `glossary-manager`, `local-lexicographer`, `narrative-summarizer`, `omission-detector`, `stray-phrase-detector`, `stray-phrase-fixer` |

Each tier is a full model ID and an effort level, set in `.env`
(`LEXIS_TRANSLATION_MODEL`, `LEXIS_MECHANICAL_MODEL`, `LEXIS_ASSISTANT_MODEL`,
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
```

### Tests

```sh
npm run typecheck          # src and tests
npm run test:unit          # vitest: modules in isolation
npm run test:integration   # vitest: the real HTTP server and WebSocket on a free port
npm run test:e2e           # Playwright: the UI in Chromium (npx playwright install chromium first)
```

None of them needs Claude or a network. `src/sdk.ts` is the app's single
door to the Agent SDK; the tests swap it for a fake
(`test/support/fake-sdk.ts`) whose "agents" write the files the real ones
would for every stage, with scripted outcomes (incomplete audits, bad output,
rate limits, hangs) and timing, so the engine's scheduling, checks, retries,
pauses and restarts are exercised for real. The browser sign-in drives a fake `claude` binary
(`test/support/fake-claude.mjs`, accepts the code `good-code`). The passkey tests
use a software authenticator (`test/support/authenticator.ts`) in vitest and
Chromium's virtual authenticator in Playwright. The Playwright run boots three
copies of the app (`test/e2e/server.ts`): one with no Claude login for the
password and Claude sign-in flows, one already linked for the translation
workflow, and one for the passkey journey. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use a Chromium
you already have.

### CI

| Workflow | When | What |
|---|---|---|
| `ci.yml` | every PR and push to `main` | typecheck, unit + integration tests, build; Playwright in a second job (report uploaded as an artifact) |
| `docker-dry-run.yml` | every PR | the Docker Hub publish minus the push: same image name and tags, Docker Hub login check, build, then boots the image and checks the sign-in flows, tools and Claude binary inside it |
| `docker-publish.yml` | after `ci.yml` succeeds on a push to `main` (a merge), or by hand | builds and pushes `latest` and `sha-<short>` to Docker Hub |

Set the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets (and optionally the
`DOCKERHUB_REPO` variable, default `<username>/lexis`).

`zip`/`unzip` and `git` must be on `PATH` (extraction, packaging and
versioning use them). `LEXIS_DATA_DIR` overrides where projects and the Claude
login live (default `data/`); `LEXIS_DEBUG=1` echoes the Claude Code
subprocess's stderr.

## Pipeline

The engine (`src/engine/`) sequences the work; the agents (`agents/*.md`) do
it. Design and rationale: [`docs/HARNESS_DESIGN.md`](docs/HARNESS_DESIGN.md).

1. **Prepare** (code) — extract the EPUB, read the spine and the navigation
   document, and build the chapter plan: every (X)HTML document in reading
   order, text-less pages (covers, plates) excluded by default. You can
   include or exclude chapters at any time.
2. **Initialization** (serial) — language/audience parameters incl. register
   guidance and a translationese watchlist (`metadata-generator`),
   locale-aware author voice (`style-analyzer`), and a critique charter
   written in the target language (`critique-charter-generator`).
3. **Extraction** (chapters in parallel) — summaries and linguistic challenges
   (`narrative-summarizer`), term extraction (`local-lexicographer`);
   **consolidation** (serial, in reading order, pipelined behind extraction) —
   master glossary updates (`glossary-manager`).
4. **Production** (chapters in parallel, stages serial within a chapter, only
   after every chapter is consolidated) — draft (`primary-translator`) ↔
   omission audit (`omission-detector`) loop; stray source-language scan
   (`stray-phrase-detector`) ↔ fix (`stray-phrase-fixer`) loop; native critique
   (`native-critique`, charter-guided); final polish (`final-translator`);
   bounded verification (`native-critique` verification mode → at most one more
   `final-translator` pass).
5. **Review gate** — approve, or ask for another pass on every chapter or a
   chosen few: a fresh critique and polish, a polish only, or a retranslation.
6. **Package** — assets mirrored (code), OPF metadata and navigation localized
   (`ebook-packager`), zipped, validated and the custom cover applied (code).

After every agent run the harness checks what was written (the file exists,
JSON parses, reports carry their status line, translations keep the XHTML
structure) and asks again with the reason when it is not right. Loop caps are
enforced in code and recorded as warnings on the chapter; the review gate's
summary lists them.

See [`docs/LESSONS.md`](docs/LESSONS.md) for what was tried, reverted, and why —
the pipeline design is the last known good state; the engine changed who
sequences it, not what runs.

## Watching and steering a run

- **The matrix** — one row per chapter, one column per stage; each cell shows
  its state, rounds taken, duration and cost. Click a cell (or a book-wide
  step) to see its agent runs, the exact task prompt each was given, and its
  own log, with a button to run it again from there.
- **The run line** — state, why it is paused (and when it will resume by
  itself), steps done, in flight and failed, an ETA from this run's own step
  times, elapsed time and cost.
- **Pause** finishes the steps in flight and starts nothing new; **Stop**
  aborts them (they run again on resume); **Resume** continues. The
  **concurrency** control (‖) changes how many agent runs go at once, mid-run.
- **Instructions** (✎) edits the project-wide instructions; every step that
  starts afterwards sees them. The row menu (⋯) adds a **note** to one
  chapter, **excludes or includes** it, or **re-runs** it from the polish, the
  critique or the draft with a note.
- **Rate limits and usage limits** pause the run and resume on a timer (at
  Claude's reset time when it reports one). A step whose output keeps failing
  the check is marked failed and the chapter waits; the rest of the book
  continues, and the run pauses with the reason once nothing else can run.
  Retry from the cell.
- **Restarts** are safe: the run state lives in `pipeline.json` and is checked
  against the files on disk when the server starts, then continues by itself.
  A version revert (paused runs only) re-reads the files the same way.
- **The assistant** (the chat box) answers questions from the files and makes
  changes on your behalf: it can edit the notes (lock a glossary term), attach
  notes, and ask the engine to re-run chapters — which then shows up in the
  matrix like any other work. It never translates by itself.
- **Activity** shows every agent's text and tool calls, attributed to its
  chapter; filter it to one chapter or to the engine and assistant only.

## How it works

- **One project = one workspace** under `data/projects/<id>/workspace/` with the
  pipeline's directory layout (`original/`, `notes/`, `draft/`, `critique/`,
  `final/`), plus `pipeline.json` and `events.jsonl` beside it.
- **Each agent run is its own `query()`**: the agent's prompt is the system
  prompt, a templated task prompt names the exact files for that chapter, the
  tools are the agent's file tools only (no shell, no web, no subagents),
  sandboxed to the workspace by a PreToolUse hook that also keeps `original/`
  read-only, under a turn cap, a dollar cap and a wall-clock timeout. Sessions
  run with `settingSources: []` so nothing from local Claude settings leaks
  in, and are not persisted (the feed is the record).
- **The scheduler** runs whatever is ready, most urgent first (glossary merges,
  then earlier chapters, then deeper stages), up to the concurrency setting.
  Dependencies are the pipeline's: extraction after the metadata, production
  after the whole glossary and initialization, packaging after your approval.
- **Live UI** — every event (step and run changes, agent text, tool calls, the
  gate, versions, usage) is persisted per project and streamed over a
  WebSocket, tagged with its step and chapter.
- **Versioning** — the workspace is a git repository. The engine snapshots at
  milestones (initialization, glossary, each chapter's verification, before a
  re-run or a revision, packaging) and the UI shows the timeline with one-click
  revert while the run is paused. Reverts are non-destructive: the current
  state is snapshotted first and the revert itself is a new version.
- **Usage & cost** — per-model token usage and cost come from the SDK's
  figures at the end of each agent run, and are shown live from streamed
  token counts (priced from the standard table, marked `~`) while runs are in
  flight; per step, per chapter and per project. Costs are API-equivalent
  numbers — actual spend on an API key, an estimate on a subscription.
- **Custom cover (optional)** — upload a cover any time. It is applied when the
  book is packaged; afterwards "Repackage" swaps it deterministically without
  spending any tokens.

## Endpoints

| Method & path | Purpose |
|---|---|
| `POST /api/projects` | multipart: `epub`, `name?`, `targetLanguage`, `context?` |
| `GET /api/projects/:id/pipeline`, `GET /api/projects/:id/step?id=` | the run: chapters, steps, progress, usage; one step with its prompts |
| `POST /api/projects/:id/run/{start,pause,resume,stop}`, `PUT …/run/concurrency` | run control |
| `PUT /api/projects/:id/instructions`, `PATCH …/chapters/:key` | instructions; chapter include/exclude, note, title |
| `POST /api/projects/:id/chapters/rerun`, `POST …/steps/retry` | `{chapters, from: draft\|critique\|final, note?}`; `{id}` |
| `POST /api/projects/:id/review` | `{decision: approve\|revise, instructions?, chapters?, from?}` |
| `POST /api/projects/:id/message` | chat with the assistant |
| `GET/POST /api/projects/:id/versions`, `POST …/versions/:vid/revert` | versioning (revert while paused) |
| `POST /api/projects/:id/cover`, `POST /api/projects/:id/repackage` | custom cover |
| `GET /api/projects/:id/download` | the translated EPUB |
| `GET /api/projects/:id/events?after=&step=&run=&chapter=`, `GET /ws?project=<id>&after=<seq>` | the event log; the live stream (replays history first) |
| `GET /api/auth/state`, `POST /api/auth/password`, `POST /api/auth/passkey/{options,verify}`, `POST /api/auth/logout` | sign-in |
| `GET /api/auth/security`, `POST /api/auth/passkeys/{options,verify}`, `POST /api/auth/passkeys/:id/rename`, `DELETE /api/auth/passkeys/:id`, `DELETE /api/auth/sessions/:id`, `POST /api/auth/sessions/revoke-others`, `POST /api/auth/stepup/…` | passkeys, sessions, confirmation |
| `GET /api/claude`, `POST /api/claude/login/{start,code,cancel}`, `POST /api/claude/logout` | link the container to a Claude subscription |
| `GET /healthz` | health check (no sign-in) |

Everything under `/api` (except sign-in) and `/ws` needs a session cookie.
