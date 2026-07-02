import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { WebSocketServer, WebSocket } from 'ws';
import { coverMime, replaceCover } from './epub.js';
import { sessionFor } from './orchestrator.js';
import { createProject, getProject, listProjects, type Project } from './projects.js';
import { listVersions, revertToVersion, saveVersion } from './versioning.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4700);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

function requireProject(req: express.Request, res: express.Response): Project | undefined {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'project not found' });
    return undefined;
  }
  return project;
}

const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<void> | void) =>
  (req: express.Request, res: express.Response) => {
    Promise.resolve(fn(req, res)).catch((error) => {
      console.error(error);
      if (!res.headersSent) res.status(500).json({ error: String(error) });
    });
  };

// ---------- projects ----------

app.get('/api/projects', (_req, res) => {
  res.json(listProjects().map((p) => p.meta));
});

app.post(
  '/api/projects',
  upload.single('epub'),
  wrap(async (req, res) => {
    if (!req.file || !req.file.originalname.toLowerCase().endsWith('.epub')) {
      res.status(400).json({ error: 'an .epub file is required' });
      return;
    }
    const { name, targetLanguage, context } = req.body as Record<string, string>;
    if (!targetLanguage?.trim()) {
      res.status(400).json({ error: 'targetLanguage is required' });
      return;
    }
    const project = createProject({
      name: name?.trim() || req.file.originalname.replace(/\.epub$/i, ''),
      targetLanguage: targetLanguage.trim(),
      context: context?.trim() ?? '',
      epubBuffer: req.file.buffer,
      epubFilename: req.file.originalname,
    });
    res.json(project.meta);
  }),
);

app.get(
  '/api/projects/:id',
  wrap(async (req, res) => {
    const project = requireProject(req, res);
    if (!project) return;
    res.json({
      ...project.meta,
      versions: await listVersions(project),
      awaitingReview: sessionFor(project).awaitingReview,
    });
  }),
);

app.get('/api/projects/:id/events', (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const after = Number(req.query.after ?? 0);
  res.json(project.readEvents(after));
});

// ---------- orchestration ----------

app.post(
  '/api/projects/:id/start',
  wrap(async (req, res) => {
    const project = requireProject(req, res);
    if (!project) return;
    const session = sessionFor(project);
    session.send(
      `Begin the translation of source.epub into ${project.meta.targetLanguage}. ` +
        (project.meta.context ? `User context: ${project.meta.context}. ` : '') +
        `Run the full pipeline from Preparation onward. If the workspace already contains partial pipeline output (original/, notes/, draft/, final/), assess what is already done and continue from there instead of redoing completed work.`,
    );
    res.json({ ok: true });
  }),
);

app.post(
  '/api/projects/:id/message',
  wrap(async (req, res) => {
    const project = requireProject(req, res);
    if (!project) return;
    const text = String((req.body as { text?: string }).text ?? '').trim();
    if (!text) {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    sessionFor(project).send(text);
    res.json({ ok: true });
  }),
);

app.post(
  '/api/projects/:id/review',
  wrap(async (req, res) => {
    const project = requireProject(req, res);
    if (!project) return;
    const { decision, instructions } = req.body as { decision?: string; instructions?: string };
    if (decision !== 'approve' && decision !== 'revise') {
      res.status(400).json({ error: "decision must be 'approve' or 'revise'" });
      return;
    }
    const resolved = sessionFor(project).resolveReview(decision, instructions);
    if (!resolved) {
      res.status(409).json({ error: 'no review is pending' });
      return;
    }
    res.json({ ok: true });
  }),
);

app.post(
  '/api/projects/:id/interrupt',
  wrap(async (req, res) => {
    const project = requireProject(req, res);
    if (!project) return;
    await sessionFor(project).interrupt();
    res.json({ ok: true });
  }),
);

// ---------- versions ----------

app.get(
  '/api/projects/:id/versions',
  wrap(async (req, res) => {
    const project = requireProject(req, res);
    if (!project) return;
    res.json(await listVersions(project));
  }),
);

app.post(
  '/api/projects/:id/versions',
  wrap(async (req, res) => {
    const project = requireProject(req, res);
    if (!project) return;
    const label = String((req.body as { label?: string }).label ?? 'manual snapshot');
    const version = await saveVersion(project, label);
    res.json(version ?? { unchanged: true });
  }),
);

app.post(
  '/api/projects/:id/versions/:vid/revert',
  wrap(async (req, res) => {
    const project = requireProject(req, res);
    if (!project) return;
    const version = await revertToVersion(project, req.params.vid);
    // Keep the orchestrator's mental model in sync if a session is live.
    const session = sessionFor(project);
    if (session.running) {
      session.send(
        `[The user reverted the workspace to version ${req.params.vid.slice(0, 8)} via the UI. Re-read the workspace state (notes/, draft/, final/) before doing anything else, and adjust your plan to match what actually exists now.]`,
      );
    }
    res.json(version);
  }),
);

// ---------- cover & packaging ----------

app.post(
  '/api/projects/:id/cover',
  upload.single('cover'),
  wrap(async (req, res) => {
    const project = requireProject(req, res);
    if (!project) return;
    if (!req.file || !coverMime(req.file.originalname)) {
      res.status(400).json({ error: 'a jpg/png/gif/webp/svg image is required' });
      return;
    }
    // Remove older overrides so the packager sees exactly one.
    for (const f of fs.readdirSync(project.workspace)) {
      if (f.startsWith('cover_override.')) fs.rmSync(path.join(project.workspace, f));
    }
    const ext = path.extname(req.file.originalname).toLowerCase();
    const dest = `cover_override${ext}`;
    fs.writeFileSync(path.join(project.workspace, dest), req.file.buffer);
    project.meta.coverFilename = dest;
    project.save();
    project.emit('status', 'user', {
      status: project.meta.status,
      detail: `Custom cover uploaded (${dest})`,
    });
    res.json({ ok: true, coverFilename: dest });
  }),
);

app.post(
  '/api/projects/:id/repackage',
  wrap(async (req, res) => {
    const project = requireProject(req, res);
    if (!project) return;
    if (!project.meta.outputPath || !project.meta.coverFilename) {
      res.status(400).json({ error: 'requires a completed epub and an uploaded cover' });
      return;
    }
    const epub = path.join(project.workspace, project.meta.outputPath);
    const cover = path.join(project.workspace, project.meta.coverFilename);
    await replaceCover(epub, cover);
    await saveVersion(project, 'repackaged with custom cover');
    project.emit('progress', 'orchestrator', {
      phase: 'packaging',
      state: 'completed',
      detail: 'Repackaged with custom cover (deterministic, no agent involved)',
    });
    res.json({ ok: true });
  }),
);

app.get('/api/projects/:id/download', (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  if (!project.meta.outputPath) {
    res.status(404).json({ error: 'no translated epub yet' });
    return;
  }
  const file = path.join(project.workspace, project.meta.outputPath);
  res.download(file, `${project.meta.name} (${project.meta.targetLanguage}).epub`);
});

// ---------- websocket ----------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws: WebSocket, req) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  const project = getProject(url.searchParams.get('project') ?? '');
  if (!project) {
    ws.close(4004, 'unknown project');
    return;
  }
  const after = Number(url.searchParams.get('after') ?? 0);
  for (const event of project.readEvents(after)) {
    ws.send(JSON.stringify(event));
  }
  const unsubscribe = project.subscribe((event) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  });
  ws.on('close', unsubscribe);
});

server.listen(PORT, () => {
  console.log(`lexis (claude agent sdk) listening on http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.warn(
      'note: neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set. ' +
        'The orchestrator will still work if this machine is logged in to Claude Code ' +
        'with a subscription (`claude` then `/login`); otherwise provide one of the two.',
    );
  }
});
