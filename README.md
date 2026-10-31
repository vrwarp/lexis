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

lexis is one container: the Node server, the web UI, the Claude Code runtime
the Agent SDK ships, and the command-line tools the pipeline uses (`git`,
`zip`, `unzip`). Everything it keeps — projects, the books, the traces, your
Claude login and your passkeys — lives in one volume mounted at `/data`.

### What you need

- A host with Docker Engine and the Compose plugin (`docker compose`). The
  published image is `linux/amd64`; on an arm64 host build from source
  (the Dockerfile is multi-arch).
- An **https** hostname in front of it (a reverse proxy such as Caddy, nginx,
  Traefik, or the one your NAS provides). Passkeys only work in a secure
  context, and the session cookie is marked `Secure`. Plain http is fine only
  on `localhost`.
- A **Claude subscription with Opus access** (Max), or an API key. The
  translation tier runs Opus by default.
- Memory: every agent run in flight is one Claude Code process (a few hundred
  MB). The compose file caps the container at 4 GB, which is comfortable for
  the default concurrency of 3; on a smaller host set `LEXIS_CONCURRENCY=1`
  or `2`. Disk: a translated book with its versions and trace is tens of
  megabytes.

### Build from source

```sh
git clone https://github.com/vrwarp/lexis.git && cd lexis
cp .env.example .env         # then edit it: at least LEXIS_PASSWORD and LEXIS_PUBLIC_URL
docker compose up -d --build
docker compose logs -f lexis # until "lexis listening"
```

### Or run the published image

Merges to `main` that pass CI are pushed to Docker Hub as `<dockerhub-user>/lexis:latest`
and `:sha-<commit>` (see [CI](#ci) for the repository settings that enable
it). To run that instead of building, replace `build: .` in
`docker-compose.yml` with `image: <dockerhub-user>/lexis:latest` (or put the
two lines below in a `docker-compose.override.yml`, Compose ≥ 2.24), then
`docker compose pull && docker compose up -d`:

```yaml
services:
  lexis:
    build: !reset null
    image: <dockerhub-user>/lexis:latest
```

### Configure: `.env`

Copy `.env.example`; it documents every setting. The ones that matter:

| Setting | Required | What it does |
|---|---|---|
| `LEXIS_PASSWORD` | yes | The password. It signs you in the first time (to set up a passkey) and always works as the backup, so make it long and random (`openssl rand -base64 24`). |
| `LEXIS_PUBLIC_URL` | yes | The address you open lexis at, e.g. `https://lexis.example.com`. Passkeys are bound to this host and requests from any other origin are refused. |
| `COOKIE_SECURE` | yes (`1` over https) | Secure `__Host-` session cookie and HSTS. Set `0` only for plain-http `localhost` use. |
| `LEXIS_TRUST_PROXY` | behind a proxy | How many reverse proxies sit in front (usually `1`). Lets the password attempt limits see real client addresses. |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | no | A credential instead of the web sign-in: a long-lived subscription token from `claude setup-token`, or an API key billed per token. Either outranks the web sign-in. Leave both empty to sign in from the browser. |
| `LEXIS_TRANSLATION_MODEL`, `LEXIS_MECHANICAL_MODEL`, `LEXIS_ASSISTANT_MODEL` | no | Full model ids per tier (defaults `claude-opus-5-5`, `claude-sonnet-5-5`, mechanical). See [Models](#models). |
| `LEXIS_TRANSLATION_EFFORT`, `LEXIS_MECHANICAL_EFFORT`, `LEXIS_ASSISTANT_EFFORT` | no | `low` … `max` per tier (defaults `high`, `medium`, `medium`). |
| `LEXIS_CONCURRENCY` | no | Agent runs in flight at once, 1–8 (default 3). Changeable per run in the UI. |
| `LEXIS_LOOP_ROUNDS` | no | Draft/omission and stray/fix rounds per chapter before moving on with a warning (default 3). |
| `LEXIS_STEP_ATTEMPTS` | no | Tries per agent run when the harness rejects its output (default 2). |
| `LEXIS_STEP_TIMEOUT_MIN`, `LEXIS_MECHANICAL_TIMEOUT_MIN` | no | Wall-clock caps per agent run (defaults 60 and 30 minutes). |
| `LEXIS_STEP_BUDGET_USD`, `LEXIS_STEP_MAX_TURNS` | no | Safety nets per agent run against a looping agent (defaults $25, 80 turns). |
| `LEXIS_DEBUG` | no | `1` echoes the Claude Code subprocesses' stderr to the container log. |
| `PORT`, `LEXIS_DATA_DIR`, `CLAUDE_CONFIG_DIR` | no | Set by the image (`8080`, `/data`, `/data/claude`); change only for a non-Docker install. |

Settings are read at start: `docker compose up -d` after a change. Model,
effort and loop settings are fixed for a run once it starts (and recorded in
it); concurrency can be changed live.

### The reverse proxy

Forward to the container's port 8080 with WebSocket upgrades (the live feed
is a WebSocket at `/ws`), pass the client address, and allow uploads of the
size of your EPUBs (lexis caps them at 200 MB). Caddy does all of this with
one line:

```
lexis.example.com {
    reverse_proxy lexis:8080
}
```

nginx needs the usual:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 1h;
    client_max_body_size 200m;
}
```

With one proxy in front set `LEXIS_TRUST_PROXY=1`. If you bind the published
port to localhost only (`"127.0.0.1:8080:8080"` in the compose file) nothing
but the proxy can reach the container.

### First run

1. Open `LEXIS_PUBLIC_URL` and sign in with the password. lexis asks you to
   create a **passkey** (Face ID, Touch ID, Windows Hello, a phone or a
   security key); do it — from then on sign-in is one tap and the password is
   the backup. See [Security](#security).
2. Click **Claude** at the bottom of the sidebar → **Sign in with Claude**.
   Open the link, approve with the account that has your subscription, paste
   the code back. The login is kept in the volume, so it survives restarts and
   upgrades. (`docker compose exec lexis claude auth login` from a shell does
   the same.)
3. **New translation**: an EPUB, a target language, optional instructions,
   optionally a series. Press **Start** and watch the matrix.

### The data volume

`lexis-data` (a named volume) holds:

| Path in `/data` | What |
|---|---|
| `projects/<id>/project.json` | the project record |
| `projects/<id>/workspace/` | the book: `source.epub`, `original/`, `notes/`, `draft/`, `critique/`, `final/`, `translated_book.epub`; a git repository whose commits are the version history |
| `projects/<id>/pipeline.json`, `events.jsonl` | the run's state and the UI event log |
| `projects/<id>/trace/` | the full record of every agent run (see [Diagnostics](#diagnostics-and-analysis)) |
| `claude/` | the Claude login and the Agent SDK's own files |
| `auth/auth.json` | passkeys and signed-in sessions (`0600`) |

**Back it up** like you would the books themselves: it also holds the
Claude login. `docker run --rm -v lexis_lexis-data:/data -v "$PWD":/out
alpine tar czf /out/lexis-data.tgz -C /data .` makes an archive (the volume's
name is prefixed with the compose project's, usually the folder name). To use a
host folder instead of the named volume, mount it in place of `lexis-data`
and `chown -R 1001:1001` it: the container runs as the unprivileged user
`lexis` (uid 1001), and must — Claude Code refuses to run agents with
permissions bypassed as root.

### Operating it

- **Logs**: `docker compose logs -f lexis`. Each start logs the models and the
  credential source. `LEXIS_DEBUG=1` adds the agents' stderr.
- **Health**: `GET /healthz` answers `{"ok":true}` without a sign-in; the image
  declares it as its Docker health check.
- **Upgrade**: `git pull && docker compose up -d --build` (or `docker compose
  pull && docker compose up -d` for the published image). Data and logins
  persist. A run that was in progress pauses at the restart and resumes by
  itself; steps that were mid-flight run again from scratch.
- **From a shell in the container**: `docker compose exec lexis node dist/cli.js
  status | signout-all | reset-passkeys | trace <project> … | series`, and
  `docker compose exec lexis claude auth status`.
- **Rate limits**: on a subscription the engine pauses when Claude says so
  and resumes at the reset time it reports (the run line says when). Lower
  the concurrency if that happens often.

### If something is off

| Symptom | Cause and fix |
|---|---|
| No "Sign in with a passkey" button, or creating one fails | Not a secure context: the page must be served over https at `LEXIS_PUBLIC_URL` (or `localhost`). Check `COOKIE_SECURE=1` and that the proxy sets `Host`. |
| "Too many attempts" on the password | 5 wrong tries per address or 20 overall in 15 minutes. Wait, or sign in with a passkey. Behind a proxy without `LEXIS_TRUST_PROXY`, every client shares one address. |
| "Claude is not linked yet" when starting | Sign in under **Claude** (sidebar), or set a credential in `.env` and restart. |
| The run is paused with "usage limit" | The subscription's limit; it resumes at the reset time. Nothing to do. |
| A step is red | Open its cell: the reason and the agent's log are there; **retry** runs it again. `node dist/cli.js trace <project> failures` groups recurring causes. |
| The container keeps restarting | `docker compose logs lexis`. The usual cause is a missing `.env` or a volume the `lexis` user cannot write (`chown -R 1001:1001`). |
| The browser says the session ended | Sessions end after 14 idle days or 30 in all, or when signed out from **Security** on another device. Sign in again. |

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

## Develop (or run without Docker)

```sh
npm install
LEXIS_PASSWORD=dev npm run dev        # http://localhost:4700, plain http is fine on localhost
```

For a non-Docker install, `npm run build` then `node dist/server.js` with the
same `.env` settings in the environment; `zip`, `unzip` and `git` must be on
`PATH`, and the process must not run as root. `LEXIS_DATA_DIR` sets where
everything is kept (default `data/`).

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

## Books in a series

Consistency across a series is carried the way it is carried within a book:
as data. Give a book a **Series** name when you create it and choose which
earlier book to **continue from** (the latest finished one by default). When
its run starts, it inherits that book's master glossary (its entries are
settled), style guide, metadata and critique charter; the three
initialization agents then *refresh* those documents for this book — keeping
every established decision unless the new book contradicts it — instead of
writing them from nothing, and every chapter agent is told which terms are
settled. Book 3 inherits from book 2 and so carries everything. Inheritance
needs the same target language; what was inherited is shown on the run line
and recorded in the trace. `node dist/cli.js series` lists the books of each
series.

## Diagnostics and analysis

Every run is recorded in full — each agent run's task prompt, its whole
transcript (every tool call and result), the files it read and wrote, its
usage and outcome, and the engine's timeline — so a failure can be explained
after the fact and the pipeline improved from evidence. **Diagnostics** in the
project header downloads the bundle; `node dist/cli.js trace <project>
summary` prints the overview (per-stage times and costs, loop rounds,
rejections grouped by reason, concurrency utilisation, chapters to look at).
See [`docs/ANALYSIS.md`](docs/ANALYSIS.md) for what is recorded and how to
ask it questions.

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
| `POST /api/projects` | multipart: `epub`, `name?`, `targetLanguage`, `context?`, `series?`, `inheritFrom?` |
| `GET /api/series` | the books of each series and the one a new book would inherit from |
| `GET /api/projects/:id/trace/summary`, `…/trace/runs/:run/transcript`, `…/trace/export` | the run record (docs/ANALYSIS.md): JSON or `?format=text`; a run's transcript; the .tgz |
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
