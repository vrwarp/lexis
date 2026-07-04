// HTTP/WebSocket server — same endpoints and event protocol as the other
// lexis harnesses (port of claude/src/server.ts), on port 4702.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { WebSocketServer, WebSocket } from 'ws';
import { coverMime, extractEpub, generateContents, replaceCover, validateEpub } from './epub.js';
import { peekSession, sessionFor } from './orchestrator.js';
import { createProject, getProject, listProjects, type Project } from './projects.js';
import { listVersions, revertToVersion, saveVersion } from './versioning.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4702);

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
    const session = peekSession(project);
    res.json({
      ...project.meta,
      versions: await listVersions(project),
      awaitingReview: session?.awaitingReview ?? false,
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
    // Deterministically (re)extract the source so `original/` is guaranteed
    // complete on every run — including projects whose earlier run left a
    // partial extraction. The source is immutable, so this is safe/idempotent.
    const source = path.join(project.workspace, 'source.epub');
    if (fs.existsSync(source)) {
      // Preparation is fully mechanical: extract, validate, and parse the reading
      // order in code (no LLM ebook_disbinder). The source is immutable, so this is
      // idempotent and also repairs a project whose earlier run left original/ partial.
      try {
        const count = await extractEpub(source, path.join(project.workspace, 'original'));
        const warnings = validateEpub(project.workspace); // throws EpubError on a fatal problem
        const chapters = generateContents(project.workspace);
        let detail = `Extracted ${count} source files into original/`;
        if (chapters) detail += `; wrote notes/contents.json (${chapters} chapters, from the OPF spine)`;
        if (warnings.length) detail += ` (warnings: ${warnings.join('; ')})`;
        project.emit('progress', 'orchestrator', { phase: 'preparation', state: 'completed', detail });
      } catch (error) {
        // A malformed/DRM'd/corrupt EPUB is surfaced here, in code — not left for a
        // model to notice. Stop before wasting a pipeline run on unusable input.
        const message = `Preparation failed: ${error instanceof Error ? error.message : String(error)}`;
        project.emit('progress', 'orchestrator', { phase: 'preparation', state: 'failed', detail: message });
        project.setStatus('error', message);
        res.status(422).json({ ok: false, error: message });
        return;
      }
    }
    const session = sessionFor(project);
    session.send(
      `Begin the translation of source.epub into ${project.meta.targetLanguage}. ` +
        (project.meta.context ? `User context: ${project.meta.context}. ` : '') +
        `Preparation is already complete: the harness has extracted and validated source.epub into original/ and written notes/contents.json (the reading order). Run the pipeline from Initialization onward (toc_verifier, then style_analyzer, metadata_generator, then per-chapter extraction and production). If the workspace already contains partial pipeline output (notes/, draft/, final/), assess what is already done and continue from there instead of redoing completed work.`,
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
    const session = peekSession(project);
    if (!session || !session.resolveReview(decision, instructions)) {
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
    peekSession(project)?.interrupt();
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
    const session = peekSession(project);
    if (session?.running) {
      session.send(
        `[The user reverted the workspace to version ${req.params.vid.slice(0, 8)} via the UI. Re-read the workspace state (notes/, draft/, final/) before doing anything else, and adjust your plan to match what actually exists now.]`,
      );
    }
    res.json(version);
  }),
);

// ---------- assets (inspection & review) ----------

/** Resolve a user-supplied relative path safely inside the workspace. */
function resolveWorkspacePath(project: Project, rel: string): string | null {
  const abs = path.resolve(project.workspace, rel);
  if (abs !== project.workspace && !abs.startsWith(project.workspace + path.sep)) return null;
  if (path.relative(project.workspace, abs).split(path.sep).includes('.git')) return null;
  return abs;
}

const TEXT_EXTENSIONS = new Set([
  '.xhtml', '.html', '.htm', '.txt', '.md', '.json', '.css', '.opf', '.ncx', '.xml', '.svg',
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

app.get(
  '/api/projects/:id/files',
  wrap(async (req, res) => {
    const project = requireProject(req, res);
    if (!project) return;
    const files: { path: string; size: number; mtime: string; kind: string }[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
        } else {
          const stat = fs.statSync(abs);
          const ext = path.extname(entry.name).toLowerCase();
          files.push({
            path: path.relative(project.workspace, abs),
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            kind: IMAGE_EXTENSIONS.has(ext) ? 'image' : TEXT_EXTENSIONS.has(ext) ? 'text' : 'binary',
          });
        }
      }
    };
    walk(project.workspace);
    files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    res.json(files);
  }),
);

app.get(
  '/api/projects/:id/files/content',
  wrap(async (req, res) => {
    const project = requireProject(req, res);
    if (!project) return;
    const abs = resolveWorkspacePath(project, String(req.query.path ?? ''));
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.status(404).json({ error: 'file not found' });
      return;
    }
    const size = fs.statSync(abs).size;
    const CAP = 2 * 1024 * 1024;
    const fd = fs.openSync(abs, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(size, CAP));
      fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (buffer.includes(0)) {
        res.status(415).json({ error: 'binary file — use the raw endpoint' });
        return;
      }
      res.json({ path: req.query.path, content: buffer.toString('utf8'), truncated: size > CAP, size });
    } finally {
      fs.closeSync(fd);
    }
  }),
);

app.get(
  '/api/projects/:id/files/raw',
  wrap(async (req, res) => {
    const project = requireProject(req, res);
    if (!project) return;
    const abs = resolveWorkspacePath(project, String(req.query.path ?? ''));
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.status(404).json({ error: 'file not found' });
      return;
    }
    res.sendFile(abs);
  }),
);

app.post(
  '/api/projects/:id/files/comment',
  wrap(async (req, res) => {
    const project = requireProject(req, res);
    if (!project) return;
    const { path: filePath, comment, excerpt } = req.body as {
      path?: string;
      comment?: string;
      excerpt?: string;
    };
    if (!filePath || !comment?.trim()) {
      res.status(400).json({ error: 'path and comment are required' });
      return;
    }
    if (!resolveWorkspacePath(project, filePath)) {
      res.status(400).json({ error: 'invalid path' });
      return;
    }
    const quoted = excerpt?.trim()
      ? `\n\nRegarding this passage:\n${excerpt
          .trim()
          .slice(0, 1500)
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')}`
      : '';
    sessionFor(project).send(
      `[User comment on asset \`${filePath}\`]${quoted}\n\n${comment.trim()}`,
    );
    res.json({ ok: true });
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
  console.log(`lexis (open-agent substrate) listening on http://localhost:${PORT}`);
  const keys = ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'];
  if (!keys.some((k) => process.env[k])) {
    console.warn(
      'note: no provider API key detected in the environment ' +
        `(${keys.join(' / ')} / …). The default models.json uses OpenRouter free models — set ` +
        'OPENROUTER_API_KEY (https://openrouter.ai/keys), or configure whichever provider your tiers reference.',
    );
  }
});
